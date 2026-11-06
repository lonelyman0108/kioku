// 全仓一份 ESLint 配置：TypeScript 走 typescript-eslint，.vue 文件走 eslint-plugin-vue
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      'apps/web/auto-imports.d.ts',
      'apps/web/components.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/server/**', 'packages/**', '*.js', '*.ts'],
    languageOptions: { globals: globals.node },
  },
  // Prettier 负责排版：关掉所有与它冲突的格式类规则（包括 eslint-plugin-vue 的模板排版规则）
  prettier,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
)
