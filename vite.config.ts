import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // 外觀 bootstrap 由三個 browser entry 統一先載入,頁面本體不各自讀 storage。
      // boards 仍是共用 store entry，ETA 與 setup/map 都會從 TypeScript source import。
      // 保留 entry 的全部 exports，避免共用 store 的公開 API 被 tree-shake。
      preserveEntrySignatures: 'strict',
      input: {
        map: 'web/entries/map.ts',
        eta: 'web/entries/eta.ts',
        // 常用站牌儲存層，作為共用 store entry 保留。
        boards: 'web/boards/store.ts',
        setup: 'web/entries/setup.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
