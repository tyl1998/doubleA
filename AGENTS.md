# AGENTS.md

## Highest priority: do not build your own tools to "verify"

**When changing code, do not stand up extra measurement / verification tooling just to "see it with your own eyes".** Typical anti-patterns:

- For a frontend visual issue, installing or probing a browser-automation CLI, writing CDP scripts, or sweeping across viewports;
- Writing one-off probe scripts, throwaway HTML / test pages to measure layout or widths, or running matrix experiments;
- Repeatedly running several rounds of the same kind of experiment to "confirm the same conclusion".

When **insufficient information** is the premise that makes this tempting, **ask the user first** — do not start building tools.

### If such an action is genuinely needed, confirm first

If it really is needed (for example, a defect is only visible when running), **first explain the following to the user and get their consent**:

1. What I am going to do (run a browser / start a service / write a temporary script);
2. Why reading the code or the existing scripts cannot answer this question;
3. Roughly how long it will take.

Without confirmation, do not: install new dependencies or global CLIs, add temporary scripts that are left in the repo, or hold ports / processes for a long time.

### What to do instead

- If one pass of reading code or one measurement can answer it, do not run an experiment matrix;
- Prefer reusing the repo's **existing** verification scripts (`pnpm verify:*`) and tools; do not build a parallel set;
- When a requirement or a symptom description is ambiguous, **clarify the intent first** rather than guessing and trying a few rounds;
- Once the conclusion already follows from the evidence at hand, **stop and start implementing** — do not keep adding measurements.

## Repository conventions

- Run commands with Node 22 (`.nvmrc`): `export PATH="$PATH:/Users/along/.nvm/versions/node/v22.23.3/bin"`.
- Local dev login (this machine's dev stack): `admin / admin123` (and `member / admin123`).
- After editing files, run `eslint` on the changed files; after changing source, run the matching `pnpm verify:*`.
- `curl` against localhost must always include `--noproxy '*'`.
- Do not proactively run full regressions / end-to-end tests (user decision: manual E2E).
- Commit only when the user explicitly asks.

## Sandbox layer version bump = `versions.mjs` + `infra/.env` in the same batch

`infra/sandbox/versions.mjs` is the source of truth for the sandbox layer tags, but the running
stack reads `SANDBOX_IMAGE` / `SANDBOX_IMAGE_BASE` from `infra/.env` **at startup**. Bumping
`BASE_LAYER_VERSION` / `TOOLKIT_LAYER_VERSION` (or a runtime layer) is **not complete** until the
pinned tags are updated too:

1. Rebuild: `pnpm sandbox:build` (`--toolkit-only` when only toolkit changed; rebuild the
   `--runtime` variants when their layer changed — old `*-v<n>` images are never auto-rebuilt).
2. Update `infra/.env` to the two refs the build prints: `SANDBOX_IMAGE_BASE=...` and
   `SANDBOX_IMAGE=...`. This file is gitignored, so it never shows up in `git diff` — check it
   explicitly after every bump.
3. Restart the backend afterwards; env is a startup snapshot, so until then it keeps using the old tag.
4. Sweep remaining pins of the old tag (`rg 'sandbox-(base|toolkit):<old>'`): the image table in
   `docs/README-工程手册.md`, `deploy/env/deploy.env.example`, and the fallback defaults in
   `deploy/scripts/_lib.sh` / `deploy/scripts/up.sh`.

Why this is mandatory: one-click init compares the `SANDBOX_IMAGE` tag with `versions.mjs`. On
mismatch it prepares the expected image but still marks the `toolkitImage` step and the whole job
`failed` — the drift branch in `backend/src/sandbox/nodeBootstrap.ts` always returns `ok:false`,
because preparation alone does not make the configured (old) image ready. A successful build
therefore looks like a failed init until env + restart are done.

## i18n — every new string is a key, never a literal (P1-23)

The platform ships zh + en. **Any user-visible text added or changed by a batch must go through i18n in the same batch** — it is not a "later cleanup" step.

- **Backend `AppError` messages**: always `appMsg('app.mNNN', { p0, p1 })`, never a template literal with Chinese. A new message needs **three places**: the template in `shared/src/appMessages.ts`, the zh text in `shared/src/i18n/messages.zh.ts`, and the en text in `shared/src/i18n/messages.en.ts`. `pnpm verify:i18n` K1/K2 fails otherwise.
- **zod validation messages**: always `validationMessage('validation.<area>.<name>', { max })` (also zh + en dictionaries), never a literal.
- **Frontend**: `translate(locale, '<key>')` / `useFeedback()`; no bare Chinese in components, and no raw `message.success` / `notification.error` (only `app/feedback.ts`).
- **Exception**: domain sub-codes go in `AppError.data.code` (e.g. `SKILL_*`), never into the closed `ERROR_CODES` enum — that would force new `error.<CODE>` keys everywhere and status mapping.
- **Self-check before reporting a batch done**: `pnpm verify:i18n` must be **0 failures**, and the zh/en dictionaries must stay key-for-key aligned (missed translations are a compile error via `Record<MessageKey, string>`).