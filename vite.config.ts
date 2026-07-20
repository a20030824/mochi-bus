import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // 外觀 bootstrap 是所有 HTML 頁面的獨立 entry，由 Worker 統一注入；
      // 各互動頁只載入自己的功能 entry，避免 route/error 等靜態頁漏套外觀。
      // boards 仍是共用 store entry，ETA 與 setup/map 都會從 TypeScript source import。
      // 保留 entry 的全部 exports，避免共用 store 的公開 API 被 tree-shake。
      preserveEntrySignatures: 'strict',
      input: {
        appearance: 'web/entries/appearance.ts',
        map: 'web/entries/map.ts',
        eta: 'web/entries/eta.ts',
        route: 'web/entries/route.ts',
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
