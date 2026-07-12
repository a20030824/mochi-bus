import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // boards 仍是共用 store entry，ETA 與 setup/map 都會從 TypeScript source import。
      // 保留 entry 的全部 exports，避免共用 store 的公開 API 被 tree-shake。
      preserveEntrySignatures: 'strict',
      input: {
        map: 'web/map/main.ts',
        eta: 'web/eta/main.ts',
        // 常用站牌儲存層，作為共用 store entry 保留。
        boards: 'web/boards/store.ts',
        setup: 'web/setup/main.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
