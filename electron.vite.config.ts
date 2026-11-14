import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { thirdPartyNotices } from './scripts/third-party-notices'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer/src'),
        'monaco-esm': resolve(__dirname, 'node_modules/monaco-editor/esm/vs')
      }
    },
    // pre-bundled, the ?worker import loses its default export (the Worker constructor) in dev;
    // aliased imports are matched against exclude with their query
    optimizeDeps: { exclude: ['monaco-esm/editor/editor.worker.js?worker'] },
    plugins: [vue(), thirdPartyNotices(__dirname)]
  }
})
