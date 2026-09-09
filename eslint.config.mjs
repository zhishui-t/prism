import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // **/.graphify/** = 建图产物落各项目根（红线行为），非手写源码；
    // .agent-team/** = 团队黑板与测试资产（qa 总审补充，2026-09-08）；
    // 3rd/** = vendored 第三方子工程（上游代码，不由 Prism 的 lint 规则约束）
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.mjs',
      '**/.graphify/**',
      '.agent-team/**',
      '3rd/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
)
