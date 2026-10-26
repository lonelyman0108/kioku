// 全仓一份 ESLint 配置：TypeScript 走 typescript-eslint，.vue 文件走 eslint-plugin-vue
import js from '@eslint/js'
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
    files: ['apps/server/**', 'packages/**', 'plugins/**', '*.js', '*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // Prettier 负责排版，这里关掉与之冲突的格式类规则
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/multi-word-component-names': 'off',
    },
  },
)
