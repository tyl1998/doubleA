// @ts-check
/**
 * ESLint 扁平配置（P0-1-4 起）
 *
 * 依据：`docs/06-实施计划.md` P0-1-4 的 CI 链路 `install → lint → typecheck → build`。
 * 与 `tsc` 的分工：**类型正确性交给 tsc（strict 全家桶已开），ESLint 只管代码质量与统一约定**——
 * 因此刻意**不引类型感知规则**（type-aware），它要挂 tsconfig project service，CI 上慢且收益重叠。
 *
 * 不引 `globals` 包的理由见下方 `no-undef` 那条。
 */

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 产物 / 依赖 / 生成物不参与 lint（扁平配置没有 .eslintignore，忽略项必须写在这里）
    // 注意：扁平配置**不读 .gitignore**，所以 `backend/generated` 即使已 gitignore 也要在这里再列一次
    // （Prisma 生成物自带 `/* eslint-disable */`，这里是省掉解析开销与"靠注释兜底"的侥幸）。
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/*.map',
      'backend/generated/**',
      '.workbuddy/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      // 后端日志统一走 pino（`02` §十三）：业务代码里出现 console 通常意味着漏了 getLogger()，
      // 结果就是那行日志没有 requestId、也没有脱敏。CLI 脚本例外，见文件末尾的 override。
      'no-console': 'error',
      // 只用 `_` 前缀表达「刻意不用的参数/变量」（与 tsc 的 noUnusedParameters 互补：
      // tsc 只看得到未使用，ESLint 还能盯住「声明了却没用」的写法）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 允许 `x == null`（同时覆盖 null/undefined，是有意为之的简写）
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    // `.js/.mjs/.cjs`（infra/scripts 下的施工脚本、vite 配置）是**纯 JS**，
    // typescript-eslint 不会为它们关掉 `no-undef`，而 Node/浏览器全局（process/URL/fetch…）
    // 本就由运行时与 tsc 的 lib/types 保证。为这一个规则多装一个 `globals` 包不值当，直接关掉。
    files: ['**/*.{js,mjs,cjs}'],
    rules: { 'no-undef': 'off' },
  },

  {
    // 施工/验收脚本 + CLI：控制台输出就是它的接口
    // （`pnpm infra:verify` 的 PASS/FAIL 要能直接被 grep；`prisma/seed.ts` 要打印初始密码，
    //  那是**交付初始密码的唯一通道**，与业务代码走 pino 的口径不冲突 —— 它不是在记日志）
    files: ['**/scripts/**/*.{js,mjs}', '**/*.config.{js,mjs,ts}', '**/prisma/seed.ts'],
    rules: { 'no-console': 'off' },
  },
)
