import { defineConfig, devices } from '@playwright/test'

// 這裡是「起真的瀏覽器點畫面」的整合測試,跟 vitest 的 node/workers project
// 分開:desktop 跑所有非視覺流程,touch project 只跑需要真實觸控能力的規格,
// 視覺快照另立 project,讓 CI 能完整跑互動矩陣而不依賴平台限定的圖片。
export default defineConfig({
  testDir: 'test/e2e',
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}',
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:8787/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8787',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: [/mobile-touch\.spec\.ts/, /(?:map|ui)-visual\.spec\.ts/],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-touch',
      testMatch: /mobile-touch\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'visual-chromium',
      testMatch: [/(?:map|ui)-visual\.spec\.ts/],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
