import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // ETA / setup 頁的 inline script 在建置圖之外 import boards.js,
      // 必須保留 entry 的全部 exports,不能被 tree-shake。
      preserveEntrySignatures: 'strict',
      input: {
        map: 'web/map/main.ts',
        // 常用站牌儲存層,ETA / setup 頁的 inline module script 也直接 import 這支。
        boards: 'web/boards/store.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
