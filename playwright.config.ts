import { defineConfig } from '@playwright/test'

// 這裡是「起真的瀏覽器點畫面」的整合測試,跟 vitest 的 node/workers project
// 分開:不掛進 npm test/check(每次 PR 都裝瀏覽器成本太高),需要時手動
// `npm run test:e2e` 執行,CI 要不要每次跑再另外決定。
export default defineConfig({
  testDir: 'test/e2e',
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:8787/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8787',
  },
})
