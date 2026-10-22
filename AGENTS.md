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
- After editing files, run `eslint` on the changed files; after changing source, run the matching `pnpm verify:*`.
- `curl` against localhost must always include `--noproxy '*'`.
- Do not proactively run full regressions / end-to-end tests (user decision: manual E2E).
- Commit only when the user explicitly asks.