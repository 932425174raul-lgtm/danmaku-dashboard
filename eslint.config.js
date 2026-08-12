const tseslint = require('typescript-eslint')

module.exports = tseslint.config(
  {
    ignores: ['**/.vite/**', 'node_modules/**', 'out/**', 'artifacts/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', '*.config.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='console']",
          message: '正式代码不能直接写控制台，验证入口只能使用固定摘要输出器。',
        },
      ],
    },
  },
)
