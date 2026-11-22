// Lint of the app sources (pnpm lint, also in CI): rules that catch bugs, no style rules.
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['out/**', 'dist/**', 'out-*/**', 'helper/**', 'e2e/**', 'site/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  pluginVue.configs['flat/essential'],
  {
    files: ['**/*.ts', '**/*.vue'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        parser: tseslint.parser,
        project: ['tsconfig.node.json', 'tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      // TypeScript resolves names already, and does not know the globals list of ESLint
      'no-undef': 'off',
      // the APIs marked @deprecated (Electron, Node, DOM), which tsc does not report
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      // props like `ws`, `tab` and `model` are shared reactive objects, changed in place by design:
      // only assigning a prop itself is an error
      'vue/no-mutating-props': ['error', { shallowOnly: true }],
      // single-word names (Modal, Navigator) do not clash with HTML elements here
      'vue/multi-word-component-names': 'off'
    }
  },
  { files: ['**/*.{js,mjs,cjs,mts}'], languageOptions: { globals: globals.node } }
)
