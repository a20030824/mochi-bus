import { defineConfig } from 'vitest/config'

// 純 domain/lib 邏輯繼續跑在一般 Node 環境(快、可以用 node:crypto 等內建模組);
// 只有真的需要 Cloudflare Workers runtime 語意(security headers middleware、
// body limit、rate limit binding、D1/R2)的整合測試才進 workers pool,
// 兩邊測試檔案用路徑分開,互不影響彼此的執行速度與環境限制。
export default defineConfig({
  test: {
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'node',
          // test/workers 走獨立的 workers pool project;test/e2e 是 Playwright
          // 的瀏覽器整合測試,只用 `npm run test:e2e` 手動跑,不吃 vitest。
          exclude: ['**/node_modules/**', 'test/workers/**', 'test/e2e/**'],
        },
      },
      'test/workers/vitest.config.ts',
    ],
  },
})
