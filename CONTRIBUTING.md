# 貢獻指南

歡迎 Issue、Pull Request 或 Fork。這份文件只講「怎麼送 PR」，本機啟動、環境變數、頁面與 API 一覽請看 [README](README.md#本機啟動)。

## 開發流程

1. `npm install`
2. 依 [README「本機啟動」](README.md#本機啟動)建立 `.dev.vars`(需要一組免費的 [TDX](https://tdx.transportdata.tw/) 憑證)
3. `npm run dev` 啟動本機 Worker(`wrangler dev`,含模擬 D1/R2)

## 送出 PR 前

```sh
npm run check   # cf-typegen:check + vitest + tsc --noEmit + vite build + wrangler deploy --dry-run
```

這一行是 CI 的最低門檻，本機先跑過再開 PR 比較不會來回等 CI。改動到瀏覽器互動流程(`web/setup/main.ts` 之類)的話，額外跑：

```sh
npx playwright install   # 第一次要先裝瀏覽器
npm run test:e2e
```

`test:e2e` 沒有進 `npm run check` / CI(瀏覽器安裝成本目前選擇不攤進每次 push)，但改到 `/setup` 或地圖互動邏輯時請手動跑一次。

## 程式風格

- 沒有特別理由不寫註解；只在解釋「為什麼」而非「做什麼」時才加註解(隱藏限制、非顯而易見的 invariant、特定 bug 的 workaround)。既有註解多用繁體中文，維持一致。
- Domain 邏輯(`src/domain/**`)不依賴 DOM/Leaflet/Hono context,方便直接用 vitest 測試；新邏輯盡量往這個方向拆,不要一次寫進 route handler 或瀏覽器腳本裡。
- 不要為了「看起來更完整」加防禦性檢查、fallback 或抽象——只在真的會發生的情境處理錯誤，內部呼叫互相信任。
- 改動範圍盡量小而聚焦；一個 PR 做一件事，不要跟無關的重構或清理綁在一起。

## Commit / PR 慣例

這個專案的 commit 習慣用 `type(scope): 描述`，例如 `fix(map): protect city/route/network views from stale response races`、`feat(seo): noindex the setup page`、`test(ci): add Cloudflare Workers runtime integration tests`。不是強制規則，但維持一致對之後讀 log 有幫助。

大型或涉及正確性/安全/資料的改動,如果跟 [`docs/HEALTHCHECK-2026-07-10.md`](docs/HEALTHCHECK-2026-07-10.md) 裡的某個風險 ID 相關,PR 描述提一下對應 ID 會比較好追蹤;文件本身的更新慣例見該檔案最後的「更新規則」。

## 安全性問題

不要用公開 Issue／PR 討論安全漏洞細節,請照 [SECURITY.md](SECURITY.md) 的流程私下回報。

## 資料管線改動

改到 `scripts/`、`migrations/` 或快照 schema 的話,先讀 [`docs/operations/transit-snapshot-publishing.md`](docs/operations/transit-snapshot-publishing.md)——發布流程有 validate → gated publish → smoke test → rollback 的機制,不要繞過驗證閘門直接寫 D1/R2。

## 授權

送出 PR 即表示同意你的貢獻以專案採用的 [Apache-2.0](LICENSE) 授權釋出。
