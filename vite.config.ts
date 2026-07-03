import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    lib: {
      entry: 'web/map/main.ts',
      formats: ['es'],
      fileName: () => 'map.js',
      cssFileName: 'map',
    },
    sourcemap: true,
  },
})
