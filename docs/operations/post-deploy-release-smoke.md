# Post-deploy release smoke

A8 在 production Worker 部署完成後，從 GitHub-hosted runner 經由公開網路驗證實際提供服務的 release。它不是 `npm run check` 的別名，也不使用本機 Wrangler preview 作為 production evidence。

## 執行位置

`.github/workflows/deploy.yml` 的順序固定為：

```text
npm ci
→ npm run check
→ wrangler deploy --tag <full Git SHA>
→ install Chromium
→ npm run release:smoke
→ upload bounded report
```

Smoke 只在 `Deploy Worker` 成功後執行。Workflow 使用既有 `deploy-production` concurrency，且不新增 auto-merge、deployment environment 或自動 rollback。

## Release propagation gate

Runner 輪詢：

```text
GET /api/v1/health/release
```

必須同時符合：

- `schemaVersion === 1`
- `releaseSha` 精確等於觸發 workflow 的完整 `github.sha`
- `workerVersionId` 是 bounded identifier
- `workerCreatedAt` 是有效 ISO timestamp

預設最多等待 5 分鐘，每 10 秒一次。舊 SHA 或短暫 release-endpoint 網路讀取失敗留在同一 bounded timeout 內重試，不代表新 release 已壞；超時才以 `release_propagation_timeout` 結束。結構無效的 identity 不重試。

## Initial HTTP and asset smoke

確認新 release 後，依序驗證：

- `/`
- `/setup`
- `/map?city=Chiayi`

Fresh-browser map 使用較小的 Chiayi dataset，避免每次部署無必要下載雙北大型 network；Taipei 仍由代表性 API smoke 覆蓋。每個頁面必須回傳 2xx HTML、DOCTYPE 與非空 title。Runner 從 HTML 的同源 `src`／`href` 開始，遞迴讀取 JS static imports、dynamic imports、CSS `@import` 與 `url()`，因此不只檢查穩定 entry files，也會實際讀取 Vite hashed chunks。

Asset graph 有固定節點上限；response body 也有固定 byte limit。外部 origin、data URL 與 blob URL 不進入 graph。任一同源 asset 404／5xx、HTML masquerading as JS/CSS、graph 無 asset、沒有 hashed chunk或超過上限都使 smoke 失敗。

## Representative API smoke

固定驗證一個高量城市與一個較小城市：

- Taipei
- Chiayi

兩城都必須通過：

- `/api/v1/map/routes` schema 2
- `source === snapshot`
- 非空 `snapshotVersion`
- 非空且有 `routeUid`／`routeName` 的 route catalogue
- `/api/v1/map/network` 64 KiB bounded prefix 的 city/version 與 catalogue 一致

Taipei 另外固定使用路線名 `307` 作為語意樣本，但不硬編 RouteUID。Runner 從已驗證的 catalogue 收集所有當期 `routeName === "307"` 的 RouteUID，去重並排序；route detail 必須至少有一個可用 snapshot variant，其 RouteUID 與該集合相交。這避免 deployment acceptance 依賴 catalogue 第一筆，也避免 TDX／snapshot 換版後沿用過期 UID。

通過 route detail 後，runner 取該 variant 第一個 stop 的 canonical place，再讀取 place arrivals。Arrivals 無論當下 realtime healthy 或 degraded，都必須維持：

- schema 1
- `scheduleSource === place-bundle`
- snapshot version 一致
- 非空 routes
- route source 只允許 realtime、stale-realtime、schedule、none
- warning 只允許既有 TDX warning enum
- realtime candidates/queries/rateLimited 欄位有效

Smoke 不刻意製造 TDX 故障，也不新增 production test backdoor。若當下自然出現 rate limit、quota 或 upstream unavailable，契約仍必須提供結構可用的 snapshot/schedule fallback。

## Fresh-browser boot

每次 deploy 使用新 Chromium browser context，`serviceWorkers: block`，依序開啟三個主要頁面。Hard failure 包含：

- document 非 2xx
- 主要 shell selector 不可見
- Map 沒有建立 Leaflet container
- browser context 讀到的 release SHA／Worker version 不一致
- `pageerror`
- console error
- 同源 JS/CSS request failure，包括 chunk load failure

不保存 console message、URL、query、stack 或 response body。

## Observation window

Initial HTTP 與 fresh-browser smoke 通過後，workflow 預設維持 10 分鐘觀察窗，每分鐘重新讀取 release endpoint。期間 release SHA 或 Worker version 改變、identity 不可讀或 release endpoint 失效都使 job 失敗。

觀察窗結束後，再跑一次完整 HTTP/assets/API postflight。這避免只在 deployment propagation 的第一個成功瞬間取樣。

## Failure policy

A8 不自動 rollback。

- release 尚未 propagation：等待，直到 bounded timeout
- hard smoke failure：deploy job 失敗，停止把此 workflow 描述成成功 deployment
- TDX degraded 但 fallback contract 有效：smoke 可成功，report 記錄 `degradedObserved`
- data/snapshot 單城問題：由 snapshot operations 處理，不回退無關 Worker

人工 rollback 前仍須確認問題可重現、命中新 release，且不是 TDX、單城 snapshot 或 transient propagation。

## Evidence and privacy

Workflow 永遠上傳 `release-smoke-report.json`，保留 14 天。

成功 report 只包含：

- release SHA
- Worker version ID／created time
- started/completed time
- page、asset、hashed asset、city counts
- 是否觀察到合法 degraded response
- browser error counters
- observation check count

失敗 report 只包含 allowlisted `failureClass` 與 expected release SHA。禁止保存完整 URL、route/stop/place identity、console message、raw Error、stack、response body、credential、token 或 secret。

## Local contract verification

Pure-domain contract由 Vitest 驗證，不需接觸 production：

```text
npm run test -- scripts/release-smoke/post-deploy.test.mjs
```

真正的 `npm run release:smoke` 預設會打 production origin；除 deploy workflow 或明確受控操作外，不應拿它當一般本機單元測試執行。
