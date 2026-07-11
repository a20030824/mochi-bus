# Mochi Bus 健檢紀錄與整改計畫 — 2026-07-10

> 本文件是 2026-07-10 深度健檢的可追蹤紀錄，也是後續修改的執行藍圖。
> 狀態：**整改進行中；Phase 0 已部署驗證，Phase 1 tooling 已提交，API input protection 已部署**。

## 1. 紀錄資訊

| 項目 | 內容 |
| --- | --- |
| 專案 | Mochi Bus / `mochi-tools` |
| 稽核日期 | 2026-07-10（Asia/Taipei） |
| 稽核版本 | `main` @ `229637b` |
| Git 狀態 | `main` 比 `origin/main` 超前 1 個 commit；建立本文件前工作目錄無未提交修改 |
| 技術棧 | Cloudflare Workers、Hono、D1、R2、Vite、Leaflet、TDX |
| 稽核型態 | 原始碼、測試、建置、依賴、CI、資料快照、線上 HTTP/TLS 與實際 payload 的唯讀健檢 |
| 本次變更 | 只新增本文件，未修改產品程式、資料庫、Cloudflare 設定或部署內容 |

## 2. 結論先行

專案不是「需要重寫」的狀態。核心方向、領域拆分、快照思路與既有測試都有不錯的基礎；目前最大的問題，是產品能力已經長得比保護它的工程護欄更快。

最優先要處理的不是視覺微調，而是以下五件事：

1. **傳輸安全**：HTTP 未強制跳 HTTPS、未送 HSTS，且邊緣仍接受 TLS 1.0/1.1；BYOK Client Secret 因此承受不必要風險。
2. **公車路線識別正確性**：多個子路線共用相同路線名稱時，現行資料流會遺失 `SubRouteUID`，可能拿到錯誤 ETA、班表或收藏。
3. **非同步競態與 API 防護**：快速切城市／路線可能被舊回應覆蓋；公開重型端點缺少嚴格 body、schema、rate limit 與併發保護。
4. **快照發布安全**：目前同步流程缺少「產生 → 驗證 → 發布 → 冒煙測試 → 回滾」閘門，錯誤或空資料可能成為 active snapshot。
5. **全路網效能**：臺北全路網資料量遠超行動裝置的舒適範圍，需要專用低細節層（LOD），中期再走向向量瓦片／PMTiles 與 Web Worker。

### 主觀工程評分

這不是業界標準分數，而是用來排優先順序的內部基準。

| 面向 | 分數 | 評語 |
| --- | ---: | --- |
| 產品方向 | 8/10 | 「站點作為網路節點」與城市路網視角有辨識度，不該追著通用地圖做完整導航 |
| 領域設計 | 7/10 | 已有 domain/infrastructure 分層，但路線 pattern identity 尚未貫穿 |
| 測試基礎 | 6.5/10 | 98 個單元測試全過，但缺 Workers runtime、D1/R2/Cache 與瀏覽器競態測試 |
| 維運與資料 | 6/10 | immutable snapshot 思路好；發布驗證、回滾、告警與失敗隔離不足 |
| 安全 | 5/10 | 依賴無已知漏洞，但 edge transport、BYOK、CSP、rate limit 是實質缺口 |
| 效能 | 5/10 | 單一路線可接受，全路網在大型城市的 payload、parse 與記憶體成本過高 |
| 可維護性 | 6/10 | 核心可讀，但瀏覽器腳本內嵌且 `web/map/main.ts` 過大，型別與模組邊界不足 |

## 3. 已完成的驗證基線

| 檢查 | 結果 | 備註 |
| --- | --- | --- |
| `npm test` | 通過 | 14 個 test files、98/98 tests |
| `npm run typecheck` | 通過 | 現有 TypeScript 設定下無錯誤 |
| Vite production build | 通過 | `map.js` 約 189.7 KB（gzip 約 56 KB）；`map.css` 約 25.94 KB（gzip 約 9.08 KB） |
| Wrangler dry-run | 通過 | D1/R2 bindings 可解析 |
| `npm audit` | 通過 | production 與完整依賴均為 0 個已知漏洞 |
| 22 城市 route snapshot smoke test | 通過 | `/api/v1/map/routes` 全部回 200，且來源為 snapshot |
| `wrangler types --check` | **失敗** | `worker-configuration.d.ts` 過期；`.dev.vars` 混入只供同步腳本使用的 R2/account 變數 |
| GitHub Actions 最新排程 | 通過 | run #16 成功；前兩次 #14/#15 因 TDX token endpoint HTTP 400 在 publish 階段失敗 |
| 線上 HTTP | **失敗** | `http://bus.moc96336.com/`、`/setup`、`/api/v1/map/cities` 皆直接回 200，未跳 HTTPS |
| 線上 TLS | **失敗** | OpenSSL 實測 TLS 1.0、1.1、1.2、1.3 均可協商 |
| 線上安全標頭 | **不足** | 未見 HSTS、CSP／`frame-ancestors` 或 `X-Frame-Options` |

### 大型路網量測

以臺北本地 network snapshot 為例：

- raw JSON 約 **35.75 MiB**。
- 1,750 個 directions、3,880 個 stops、1,766,952 個座標。
- Node 合成量測：JSON parse 約 326 ms／heap 增量約 131 MiB；建立 index 約 276 ms／typed buffers 約 60.8 MiB；RSS 約 335 MiB。
- 唯讀 50 m LOD 實驗：座標減少約 **93.5%**，raw JSON 降至約 3.01 MiB，gzip 約 0.43 MiB，index 約 68 ms／4.1 MiB。
- 線上臺北 payload 量測約 8.72 MB gzip、嘉義約 1.92 MB gzip。外部網路時間會受稽核位置影響，數值只能作為基線，不等同 Core Web Vitals。

### 量測限制

- 本輪 Chrome DevTools MCP 不可用，因此沒有可靠的 LCP、INP、CLS 實測；不得把上述 Node 合成數據當作真實手機 CWV。
- 遠端 D1 直接 freshness query 因授權失敗未完成；已改以公開 snapshot API 驗證 22 城市可讀。
- TLS 與 HTTP 結果是 2026-07-10 的線上狀態；邊緣設定變更後必須重新測試。

## 4. 風險登錄表

| ID | 等級 | 問題 | 主要證據／位置 | 目標階段 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | P0 | HTTP 未跳 HTTPS、無 HSTS、仍接受 TLS 1.0/1.1 | 線上實測；`web/boards/store.ts:137-153`、`src/routes/bus.ts:184-192`、`src/routes/map.ts:99-103` 會傳遞 BYOK | Phase 0 | Verified：deployment `a564a2f5-…`；HSTS Stage 1 觀察中 |
| COR-001 | P0 | 子路線識別遺失，可能混用 ETA／班表／收藏 | `src/lib/tdx.ts:22-35,580-634`、`src/domain/favorite-board.ts:65-66`、`src/routes/bus.ts:43-103` | Phase 2 | Open |
| COR-002 | P0 | Journey ETA 用第一筆而非最佳 ETA，班表跨 route flatten | `src/routes/map.ts:469-510,545-567`、`src/infrastructure/transit/snapshot-repository.ts:47-63` | Phase 2 | Open |
| DATA-001 | P0 | 快照發布前缺 schema／數量／引用完整性驗證與自動回滾 | `scripts/sync-chiayi-snapshot.mjs:117-220,293,337-355` | Phase 3 | Open |
| PERF-001 | P1 | 大型城市全路網 payload、parse、index 與記憶體過高 | `web/map/main.ts:1112-1153`、`scripts/sync-chiayi-snapshot.mjs:328` | Phase 4 | Open |
| COR-003 | P1 | 路線、路網、附近站牌與地點請求存在 stale response race | `web/map/main.ts:864-905,1112-1124,1256-1301,1924-2008`；`src/ui.ts:395-397` | Phase 2 | Open |
| SEC-002 | P1 | 公開重型 API 缺 body size、runtime schema、rate limit 與併發保護 | `src/rate-limit.ts`、`src/lib/tdx.ts`、`src/routes/map.ts:450-532` | Phase 1 | Verified：input boundaries、per-location edge rate limit、single-flight 與 credential-scoped circuit breaker 已部署 `8fa1fd3d-…` |
| SEC-003 | P1 | BYOK token cache 僅以 clientId 分桶，secret 長期存在 localStorage | `src/lib/tdx.ts`、`web/boards/store.ts:135-305`、`src/ui.ts:331-407` | Phase 1 | Verified：server fingerprint/LRU 與 session-first browser lifecycle 已部署 `b71d9105-…` |
| CICD-001 | P1 | CI secret scope 過大、Actions 用 mutable tag、缺 PR/push quality gate | `.github/workflows/sync-transit.yml:24-33,72-74` | Phase 1 | In Progress：本地 workflow 驗證通過；待 push 後首次 CI run 與 Environment 保護 |
| TEST-001 | P1 | 缺 Cloudflare Workers runtime 與瀏覽器整合／競態測試 | `vitest` 現況與測試目錄 | Phase 1-5 | Open |
| COR-004 | P1 | 轉乘時間使用固定假設卻呈現精確分鐘，且未納入步行距離 | `web/map/main.ts:1494-1506,1588-1592` | Phase 2 | Open |
| ARCH-001 | P2 | 大量 browser JS 內嵌字串未被完整 typecheck/lint，地圖主檔過大 | `src/ui.ts:63-285,379-408`、`web/map/main.ts` | Phase 5 | Open |
| QUERY-001 | P2 | nearby 先在 bbox 無排序 `LIMIT 100`，高密度區可能漏掉真正最近站牌 | `src/infrastructure/transit/snapshot-repository.ts:274-295` | Phase 2 | Open |
| CACHE-001 | P2 | Cache API write 位於回應關鍵路徑，cache failure 可能拖累或弄壞主請求 | `src/lib/edge-cache.ts`、`src/lib/tdx.ts`、`src/routes/map.ts` | Phase 1 | Verified：背景寫入與 read/write fail-open 已部署 `19229db5-…` |
| PIPE-001 | P2 | token fetch 無 timeout/retry，Retry-After 解析有陷阱，單城失敗中止整批 | `scripts/sync-chiayi-snapshot.mjs:22-54`、`.github/workflows/sync-transit.yml:72-74` | Phase 3 | Open |
| DX-001 | P2 | Node 版本文件與 Wrangler 要求不一致，bindings typegen 不可重現 | `README.md`、`.dev.vars`、`worker-configuration.d.ts` | Phase 1 | Verified：Node ≥22／CI 24 LTS；deterministic typegen check 通過 |
| A11Y-001 | P2 | 表單 label、錯誤恢復、focus、live region、對比與 reduced motion 不完整 | `src/ui.ts:332-335`、`src/map-page.ts:39-40`、`web/map/style.css` | Phase 5 | Open |
| SEO-001 | P3 | canonical／OG image／Twitter card／setup noindex 等仍可補強 | `src/seo.ts`、`src/ui.ts`、`src/map-page.ts` | Phase 5 | Open |

## 5. 詳細整改計畫

### Phase 0 — 邊緣傳輸止血（立即，獨立操作）

> 2026-07-10 執行結果：Always Use HTTPS 與 Minimum TLS 1.2 已由專案擁有者設定；Worker 308、防護標頭與 `max-age=300` HSTS 已部署為 `a564a2f5-05bc-42d1-9f1f-28bccc4ababf`。HTTP redirect、TLS 1.0–1.3、主要頁面/API、404 與 22 城市 routes 均通過線上冒煙測試。SEC-001 已標記 Verified，待 Stage 1 觀察期結束後提高 HSTS。操作證據與升級節奏見 `docs/operations/edge-security.md`。

#### P0-1：強制 HTTPS 與最低 TLS

**目標**

消除 BYOK secret 經明文 HTTP 傳輸的可能性，並淘汰 TLS 1.0/1.1。

**修改範圍**

- Cloudflare Dashboard／zone settings：開啟 Always Use HTTPS，Minimum TLS Version 設為 1.2。
- `src/index.ts`：加入應用層 HTTPS 308 防線，避免邊緣設定被誤關後完全失守；判斷時要尊重 Cloudflare 的 forwarding headers，並避免本機開發 redirect loop。
- `src/index.ts` 或共用 middleware：加入安全標頭基線。
- 新增 `docs/RUNBOOK.md` 或 `docs/operations/edge-security.md`，記錄 Dashboard 設定、驗證與回滾。

**執行細節**

1. 先把最低 TLS 改為 1.2，確認主要裝置與監控正常。
2. 開啟 Always Use HTTPS，讓 HTTP 在到達應用前被 redirect。
3. Worker 再加 308 defense-in-depth。
4. 先送短期 HSTS，例如 `max-age=300`，觀察後逐步提升到 30 天、6 個月。
5. 只有在所有子網域都完成 HTTPS 稽核後，才考慮 `includeSubDomains`；沒有完整評估前不使用 preload。

**驗收標準**

- `http://bus.moc96336.com/*` 對 GET/HEAD 一律回 301/308 至等價 HTTPS URL。
- TLS 1.0/1.1 協商失敗；TLS 1.2/1.3 成功。
- HTTPS 回應具 HSTS；設定期間 `curl -I` 不出現 redirect loop。
- `/setup` 與 BYOK API 在 HTTP 下不接受或處理 secret。

**測試**

- `curl -I http://bus.moc96336.com/`
- `curl -I https://bus.moc96336.com/`
- `openssl s_client -connect bus.moc96336.com:443 -tls1`
- `openssl s_client -connect bus.moc96336.com:443 -tls1_1`
- `openssl s_client -connect bus.moc96336.com:443 -tls1_2`
- Worker middleware 單元／整合測試：production host redirect、本機開發不 redirect。

**回滾**

- Worker 308 可回滾到前一版本。
- Always Use HTTPS 可暫時關閉，但不應作為一般故障排除手段。
- HSTS 只能等待 client cache 到期，這就是為何必須從短 `max-age` 分階段增加。

**官方依據**

- [Cloudflare — Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
- [Cloudflare — Minimum TLS Version](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)

### Phase 1 — 安全、CI 與執行環境護欄（第 1 週）

> 2026-07-10 tooling/CI 進度：新增 push/PR CI 與 Dependabot；checkout/setup-node 固定完整 commit SHA 並停用 credential persistence；snapshot secrets 已收斂到 publish step；Node engine 更新為 ≥22、CI 使用 24 LTS；Worker 與 snapshot local env 範本分離；`wrangler types --check` 已納入 `npm run check` 並在本地通過。CICD-001 要等 workflow push 後首次成功 run，並確認 Cloudflare token least privilege／GitHub Environment 保護後才能 Verified。

> 2026-07-10 API input protection 結果：commit `9e78150` 已部署為 `af3bda71-d518-487a-a7cb-288e3580e4cd`。`/journey-eta` 限制 16 KiB，依序區分 payload too large（413）、unsupported media type（415）、malformed JSON（400）與 schema violation（422）；所有 legs 必須有效且 client key 不可重複。Nearby 座標／半徑、direction、place/route/stop identifiers 與 BYOK credential pair 也加入長度、範圍及成對驗證。17 個測試檔、119/119 tests、typegen、TypeScript、build、dry-run、正常 nearby、22 城市 routes 與惡意輸入線上 smoke 全數通過。當下 SEC-002 保持 In Progress；後續 timeout/single-flight 進度見下一筆紀錄。

> 2026-07-10 TDX resilience 結果：commit `bad5f7b` 已 100% 部署為 `1f8ec17c-3ce4-496d-ba19-bfe6e4b1839b`，前一版 `af3bda71-d518-487a-a7cb-288e3580e4cd` 可直接回滾。token、pending token、invalid credential key 改用 `SHA-256(source + NUL + clientId + NUL + clientSecret)`，原始 secret 不進 Map key；token cache 採 128 筆 hard-cap LRU，pending token/data 表分別限制 64/128 筆。同憑證 token 與同 URL+credential 的 data miss 已 single-flight，不同 secret 的上游失敗不會互相污染；共用記憶體 cache 也改為 500 筆 hard-cap LRU。既有 token/data fetch 6 秒 timeout 已加入 regression test。18 個測試檔、127/127 tests、typegen、TypeScript、build、dry-run 全數通過；production deployment status 為新版 100%，首頁、cities、Chiayi routes/nearby 與 cache-busted TDX vehicle path 均回 200，HSTS/CSP 等安全標頭仍存在。SEC-002 尚待分散式 rate limit／circuit breaker；SEC-003 尚待 browser credential storage policy。

> 2026-07-10 edge rate limit／circuit breaker 結果：commit `508ee92` 已 100% 部署為 `8fa1fd3d-3621-4c9e-a7cb-0bcfb351b93a`，前一版 `1f8ec17c-3ce4-496d-ba19-bfe6e4b1839b` 可直接回滾。Wrangler 新增 standard（120/60s）、expensive（30/60s）、TDX verify（5/60s）三個 Rate Limiting bindings；頁面、cities 與 locate 不計量，其餘 API 預設受保護。公開免登入服務沒有穩定 user ID，因此 counter key 使用 Cloudflare 寫入的來源 IP；IP 不進 log／analytics／response，binding 失敗時結構化記錄且 fail-open。TDX token/data circuit 分開按 credential fingerprint 管理：60 秒內三次 timeout／5xx 開路 30 秒，429 立即開路並遵守 bounded `Retry-After`，quota 開路 5 分鐘，冷卻後只放一個 half-open probe，狀態表 hard cap 128。19 個測試檔、136/136 tests、typegen、TypeScript、build、dry-run 全數通過；production smoke 的首頁、cities、routes、nearby、vehicle path 均為 200，單一 keep-alive verify 測試由 400 收斂為 429，並確認 `Retry-After: 60`、`Cache-Control: no-store`、HSTS/CSP。注意 Workers Rate Limiting binding 官方語意是每個 Cloudflare location 的 permissive／eventually-consistent 防濫用機制，不是全球精準配額；若未來需要跨 PoP 強一致計數，應另以 Durable Object 實作。SEC-002 在此威脅模型下標記 Verified。

> 2026-07-10 BYOK browser lifecycle 結果：commit `b580dd4` 已 100% 部署為 `b71d9105-4ff8-45ea-92e0-3759f4ccabb9`，前一版 `8fa1fd3d-3621-4c9e-a7cb-0bcfb351b93a` 可直接回滾。新憑證預設只寫 `sessionStorage`，該 API 被拒絕時再退回頁面記憶體；只有 setup 頁明確勾選「記住於此裝置」才寫 `localStorage`。舊 `mochi.bus.tdxAuth.v1` 首次讀取會搬到 session、刪除長期副本並顯示一次 migration 提示；模式切換會先確認舊副本已移除，不能清除時不會假裝成功。Stored value 重新驗證型別、空白與 120/240 長度界線，清除功能同時移除 legacy/session/device/notice；UI 補上 input labels、保存期限說明，既有 Client ID 可在不把 secret 回填到畫面的情況下切換模式。20 個測試檔、146/146 tests、typegen、TypeScript、build、dry-run 全數通過；production setup HTML、stable boards entry 與 hashed store chunk 一致，首頁/cities/assets 為 200，HSTS/CSP 等安全標頭正常。SEC-003 標記 Verified。

> 2026-07-11 Cache API resilience 結果：commit `9b41401` 已 100% 部署為 `19229db5-4894-42ed-b674-1a32c6cf9ed2`，前一版 `b71d9105-4ff8-45ea-92e0-3759f4ccabb9` 可直接回滾。TDX 與即時到站的 Cache API 寫入改由 request-scoped `executionCtx.waitUntil()` 背景完成，且不變更或保存共用 bindings；無 execution context 的測試路徑則安全等待。所有 cache read/write rejection 與損壞 JSON 都會結構化記錄並 fail-open，不能再把有效 upstream 資料變成 5xx；既有 credential-scoped single-flight 保留。21 個測試檔、151/151 tests、typegen、TypeScript、build、dry-run 全數通過，並新增「未完成 cache write 不阻塞 TDX 回傳」與 read/write/scheduler failure regression tests。Production 首頁、cities、Chiayi routes/nearby 與 cache-busted vehicle path 均回 200，vehicle 同 URL 第二次由 0.72 秒降至 0.23 秒；HSTS/CSP 等安全標頭正常。CACHE-001 標記 Verified。

#### P1-1：API 輸入與資源保護

**修改範圍**

- `src/routes/map.ts`
- `src/routes/bus.ts`
- `src/index.ts`
- `wrangler.jsonc`
- 新增 request schema／middleware 模組與測試

**修改內容**

- `/journey-eta` 在讀取完整 JSON 前先檢查 `Content-Length`，並以串流／受限方式防守沒有 header 的請求；初始上限建議 16 KiB，實作前以合法最大 payload 驗證。
- 對 city、route、direction、radius、候選數、經緯度、BYOK credential 欄位做 runtime schema validation；拒絕 `NaN`、Infinity、越界座標、重複 client keys 與過量候選。
- 回應統一使用 400、413、422、429，錯誤內容不可回顯 secret。
- 對 BYOK verify、Journey ETA、nearby、重型 route/network endpoint 設 endpoint-specific rate limit；優先採 Workers Rate Limiting binding 或 zone WAF rule。
- TDX 呼叫加入 timeout、bounded retry、circuit breaker、single-flight；retry 必須只用在安全且可重試的狀態。
- 設定觀測欄位：endpoint、status、latency bucket、upstream/fallback source；不得記錄 credential 或精確位置。

**驗收標準**

- 超限 body 不會先配置大字串，回 413。
- 無效 schema 在任何 upstream／D1 查詢前回 400/422。
- 壓力測試下能穩定回 429，而不是把 TDX 或 Worker 打爆。
- 同 key 同時到達的資料請求只產生一個 upstream promise。

**測試與回滾**

- table-driven validation tests、超大 body、chunked body、重複 key、NaN／越界測試。
- Miniflare／Workers runtime integration test 驗證 rate limiter binding 與錯誤格式。
- rate threshold 以設定值／binding 管理，可單獨調整；schema breaking change 先以 log-only 觀察，再切 enforcement。

#### P1-2：BYOK 安全模型與 token cache 修正

> Server-side cache 與 browser lifecycle 已分別於 `bad5f7b`、`b580dd4` 完成並線上驗證；SEC-003 已 Verified。

**修改範圍**

- `src/lib/tdx.ts`
- `web/boards/store.ts`
- `src/ui.ts`
- `src/routes/bus.ts`
- `src/routes/map.ts`

**修改內容**

- token、pending promise 與 invalid credential cache key 改成 `SHA-256(source + NUL + clientId + NUL + clientSecret)` 的 fingerprint，避免同 clientId 不同 secret 互相污染。
- 設定 cache hard cap、TTL 與 LRU eviction；永遠不把原始 secret 寫進 log 或 error。
- localStorage 改為明確 opt-in 的「記住於此裝置」，預設只存 sessionStorage 或記憶體。
- 中期評估 BYOK v2：以短期、HttpOnly、Secure、SameSite cookie 封裝 server-side session；若 Cloudflare 儲存面無法安全落地，保持 transient 模式而非假裝安全保存。
- 清除舊 key 的 migration 與 UI 說明要納入版本發布。

**驗收標準**

- 同 clientId 搭配兩個不同 secret 不共用成功、失敗或 pending 結果。
- cache 量有硬上限，secret 不出現在 cache key dump、log、analytics 或 exception。
- 使用者可清楚知道 credential 存在哪裡並一鍵移除。

**測試與回滾**

- concurrency、eviction、TTL、invalid credential isolation、secret non-disclosure tests。
- UI storage migration test；若新版 session 有問題，可切回 transient-only，不回復長期明文保存預設。

#### P1-3：Cache write 移出回應關鍵路徑

**修改範圍**

- `src/lib/tdx.ts:666-701`
- `src/routes/map.ts:65-86`
- Hono context／Cloudflare execution context adapter

**修改內容**

- 成功取得資料後先回應，`cache.put()` 透過 `ctx.waitUntil()` 非同步完成。
- cache read/write 一律 fail-open；Cache API 異常不能把有效的 upstream 回應變成 5xx。
- 對相同資料 key 加 single-flight，避免 cache miss thundering herd。

**驗收標準**

- 模擬 `cache.put` reject 時主請求仍成功。
- 同 key 20 個並發 miss 只產生一次 upstream fetch。

> 2026-07-11 完成：以共用 fail-open adapter 統一 Cache API read/write；production 使用 `waitUntil` 背景寫入。延遲寫入、read/write rejection、scheduler failure 與 TDX 主回應不阻塞測試均通過，部署與線上 smoke 證據見風險登錄下方紀錄。既有 single-flight regression test 持續通過。

#### P1-4：CI、secret scope、Node 與 typegen

**修改範圍**

- `.github/workflows/sync-transit.yml`
- 新增 `.github/workflows/ci.yml`
- `package.json`
- `README.md`
- `.dev.vars.example`／同步腳本專用 env example
- `worker-configuration.d.ts`

**修改內容**

- Cloudflare／TDX secrets 從 job-level 移到真正需要的 step-level env。
- checkout 設 `persist-credentials: false`；第三方 actions 固定到完整 commit SHA，並由 Dependabot/Renovate 更新。
- protected environment 與 least-privilege Cloudflare API token；同步與部署 token 分離。
- PR/push CI 執行 test、typecheck、production build、Wrangler dry-run、`wrangler types --check`。
- `package.json#engines.node` 與文件統一到目前 Wrangler 支援版本；CI 固定同一 major。
- `.dev.vars` 只保留 Worker runtime secrets；snapshot publisher 的 account/R2 credential 使用獨立 env 檔範本，讓 typegen 可重現。
- production source map 不公開部署，或改為只上傳錯誤追蹤服務。

**驗收標準**

- fork PR／一般 build step 無法讀取 deploy/snapshot secrets。
- CI 的所有 quality gates 在乾淨 checkout 可重現通過。
- `wrangler types --check` 成功，bindings 型別由設定生成而不是手工漂移。

**回滾**

- workflow 改動分 PR；保留 `workflow_dispatch` 與上一個已知可用 SHA。
- Node 升級先跑全套測試與 dry-run，不和資料 schema migration 同批發布。

### Phase 2 — 路線正確性與前端一致性（第 2–3 週）

#### P2-1：建立穩定的 Route Pattern Identity

**核心決策**

`RouteUID` 不是足以唯一表達所有營運模式的識別。新增並貫穿以下概念：

```ts
interface RoutePatternRef {
  routeUid: string;
  subRouteUid: string;
  direction: 0 | 1;
}
```

若個別資料來源沒有 `SubRouteUID`，才使用明確、可重現的 fallback `patternId`，不能默默退回 route name。

**修改範圍**

- `src/lib/tdx.ts`
- `src/domain/favorite-board.ts`
- `src/domain/map/map-model.ts`
- `src/routes/bus.ts`
- `src/routes/map.ts`
- `src/infrastructure/transit/snapshot-repository.ts`
- `web/boards/store.ts`
- `web/map/main.ts`
- snapshot schema 與既有 localStorage migration

**修改內容**

- suggestion DTO 保留 `SubRouteUID`，dedupe key 不再只用顯示名稱。
- favorites、URL、API request、schedule、ETA、route detail 全部傳遞 `RoutePatternRef`。
- route detail ETA filter 加入 subroute；repository 不再以 routeName `LIMIT 1` 任選。
- server 對 client 自訂 key 重複直接拒絕，避免回應 map 被覆蓋。
- API schema 新增 `schemaVersion`；至少一個版本週期 dual-read 舊 payload，新回應同時提供新欄位。
- localStorage 收藏 migration 保留舊資料；無法唯一判定時標記「需重新選擇路線」，不能隨機配對。

**已知資料證據**

- 臺北資料掃描發現 2,695 個位置／11,391 個 key 存在多個 `SubRouteUID`。
- 基隆有 15 個重複 route name；路線「203」對應 5 個 `RouteUID`。

**驗收標準**

- 同名、多 `RouteUID`、多 `SubRouteUID` 的 fixture 可分別取得正確 ETA、班表、去返程與收藏。
- 分享 URL reload 後仍落在同一 pattern。
- 舊 favorites 不遺失；模糊資料不會被錯誤自動轉換。

**測試與回滾**

- property/table tests 覆蓋同名、多 pattern、方向 0/1、缺 subroute fallback。
- API contract snapshot tests 覆蓋 v1 compatibility 與新 schema。
- migration 使用 copy-on-write；保留原始 v1 key 一個版本週期，發生問題可回讀。

#### P2-2：修正 Journey ETA 與 schedule 聚合

**修改範圍**

- `src/routes/map.ts:450-567`
- `src/domain/map/arrival-ranking.ts`
- `src/infrastructure/transit/snapshot-repository.ts`

**修改內容**

- 用既有 `selectBestEta`／明確 ranking 取最佳 ETA，不使用第一筆 `.find()`。
- schedules 以 `RoutePatternRef` 分桶，不跨 route flatten。
- fan-out 改用 bounded concurrency + `Promise.allSettled()`；單一路線 upstream 失敗不拖垮整個 journey。
- 回應包含 `source`、`updatedAt`、partial/degraded 狀態，前端能誠實呈現資料品質。

**驗收標準**

- 亂序 ETA input 仍選出相同最佳結果。
- 其中一條 route 失敗時，其餘結果仍回傳，並標記 partial。
- schedule 不會跨 pattern 污染。

#### P2-3：統一取消與 stale response 防護

**修改範圍**

- `web/map/main.ts`
- `src/ui.ts`，後續搬到獨立 `web/setup/main.ts`
- 新增 browser request coordinator

**修改內容**

- route、network、nearby、place、setup verification 各有 request epoch 與 `AbortController`。
- 每次 await 前捕捉 city／route／place identity；await 後先比較目前狀態，舊回應不得更新 store、DOM、URL 或 cache。
- 城市切換時主動 abort 所有 city-scoped request。
- UI 區分 aborted、network error、empty data，並確保 skeleton 一定進入 terminal state。

**驗收標準**

- 以人工延遲製造 A 慢、B 快時，最後畫面、URL 與 store 永遠是 B。
- abort 不顯示錯誤 toast；真正失敗不會留下無限 skeleton。

**測試與回滾**

- Vitest fake timers 驗證 coordinator。
- Playwright route interception 模擬 out-of-order response。
- 先逐 flow 導入，不一次重寫整個 map state。

#### P2-4：Nearby 查詢與轉乘呈現誠實化

**Nearby 修改**

- 修正 bbox query 的候選策略：使用可索引的 cell/geohash 或擴大候選後，以 Haversine 排序再 limit。
- 補高密度站點 fixture，確保 `LIMIT 100` 不會先截掉最近站。
- 修正轉乘 grid 在緯度 26.4 左右的經度尺寸，避免 350 m 邊界漏配。

**轉乘修改**

- 在模型可靠前，移除「精確總分鐘」與武斷的 comfortable 標籤，改顯示估算範圍與假設。
- 將 `transferWalkMeters` 轉成步行時間，加入安全 buffer；車上時間需以可解釋資料來源估算。
- 若即時資料不足，明確顯示「未含候車／路況」而不是加固定魔法數字。

**驗收標準**

- 高密度與 grid 邊界測試都不漏最近候選。
- UI 不會把固定 `2 min/stop`、`+20 min` 包裝成精確預測。

### Phase 3 — 快照供應鏈安全（第 3 週）

#### P3-1：拆成 generate → validate → publish → verify

**修改範圍**

- 將 `scripts/sync-chiayi-snapshot.mjs` 改名或拆成通用 `scripts/transit-snapshot/*`
- `.github/workflows/sync-transit.yml`
- D1 snapshot metadata／R2 pointer 寫入邏輯
- 新增 validator、smoke test、rollback command 與 runbook

**驗證閘門**

每個城市在 publish 前至少驗證：

- JSON/schema version、必填欄位與 checksum。
- routes、directions、stops、coordinates 非空，且相對前一版的增減比未超出合理區間。
- route → direction → stop／shape 的 referential integrity。
- 座標有限、落在合理範圍，polyline 無明顯異常跳點。
- R2 object 已存在、大小與 checksum 正確後，才原子性更新 active pointer。
- active pointer 保留 previous version，發布後公開 API smoke test 失敗可一鍵切回。

**失敗隔離**

- 城市級 `allSettled`：單一城市失敗不阻止其他城市驗證／發布，但 workflow 最終要明確標示 partial failure。
- token／TDX fetch 加 timeout、指數退避與 jitter；只對 429、408、特定 5xx 重試。
- `Retry-After` 缺失時不能因 `Number(null) === 0` 誤判為零秒。
- 設 workflow timeout、artifact 保存、失敗通知與手動重跑單城參數。

**驗收標準**

- 空 routes、截斷 JSON、錯 checksum、異常資料量都無法成為 active。
- publish 後 smoke test 故意失敗時，自動／手動 rollback 能恢復 previous pointer。
- 每個 snapshot 能追到 source、generatedAt、publishedAt、schemaVersion、checksum 與 workflow run。

**測試與回滾**

- validator fixture：正常、空資料、缺引用、座標越界、數量驟減、corrupt object。
- 在測試 bucket／namespace 演練 publish 和 rollback，再碰 production pointer。
- 不刪除上一個已知良好物件；依 retention policy 延後清理。

### Phase 4 — 全路網效能（第 4 週）

#### P4-1：先落地專用 Network LOD

**修改範圍**

- snapshot generator／schema
- `src/infrastructure/transit/snapshot-repository.ts`
- `src/routes/map.ts`
- `web/map/main.ts`
- performance regression script

**修改內容**

- 為「全路網鳥瞰」產生 30–50 m 的專用簡化 geometry；單一路線詳情保留目前約 8 m 精度。
- route metadata 與 geometry 分離，避免使用者只看列表也下載完整線段。
- 支援 gzip/br、ETag、immutable version URL；active pointer 只是一個小 metadata response。
- client 先取 viewport／city metadata，geometry 延後載入；解析與 index 建立移至 Web Worker。
- schema 增加 LOD/version，舊 client 仍可讀既有格式一個版本週期。

**第一階段效能預算（待真機基線確認）**

| 指標 | 初始門檻 |
| --- | ---: |
| 臺北 network geometry gzip | < 1 MiB |
| 臺北 network raw JSON／binary equivalent | < 5 MiB |
| 臺北 network 座標數 | < 200,000 |
| Node reference index time | < 100 ms |
| 大型路網 schema validation | CI 必須通過 |

這些是 regression budget，不是對真實手機互動效能的替代。完成後仍需量測中階 Android 的 LCP、INP、CLS、long tasks 與 peak memory。

**驗收標準**

- 視覺比對下，城市級鳥瞰沒有影響辨識的斷裂或嚴重偏移。
- 單一路線檢視維持高精度。
- 大型城市 payload 超出 budget 時 CI 失敗。
- 主執行緒不再同步解析／index 巨型 geometry。

**回滾**

- 以 schema/LOD 版本和 feature flag 漸進啟用。
- server 可暫時回傳舊 snapshot；active pointer 與前端版本需保有相容矩陣。

#### P4-2：中期評估 Vector Tiles／PMTiles

若 LOD 後仍無法在低階行動裝置穩定運作，再做小型技術 spike：

- 比較 PMTiles、MVT tiles 與現有 JSON 的生成時間、R2 成本、cache hit、viewport 首屏、互動與開發複雜度。
- 不在沒有量測前全面改寫 renderer。
- 成功條件是「城市鳥瞰更快且營運複雜度可接受」，不是只因技術更新而更換格式。

### Phase 5 — 測試、模組化、可用性與產品信任（第 5–6 週）

#### P5-1：建立測試金字塔

**新增層級**

1. 現有純 domain unit tests：持續保留，補 route pattern、ranking、grid boundary、migration。
2. Cloudflare Workers integration：使用官方 Workers Vitest pool，涵蓋 Hono routes、bindings、D1、R2、Cache、`waitUntil`、body limit 與錯誤格式。
3. API contract tests：v1 compatibility、schema version、partial/degraded response。
4. Playwright：城市／路線快速切換、BYOK setup、收藏 migration、空資料／500／429、分享 URL reload。
5. Accessibility：axe + keyboard smoke；手動測 screen reader announcement 與 reduced motion。
6. Performance budget：snapshot size／coordinates／parse/index reference、bundle budget；部署後另做真機 CWV。

#### P5-2：把內嵌腳本外移並拆分地圖模組

**修改範圍**

- `src/ui.ts`
- `src/map-page.ts`
- `web/map/main.ts`
- 新增 `web/setup/*`、`web/eta/*`、`web/map/api/*`、`web/map/state/*`、`web/map/views/*`

**修改內容**

- 將 HTML template、browser behavior、API client、state machine 和 Leaflet rendering 分開。
- 所有 browser code 納入 TypeScript、lint、test 與 Vite build。
- 清除 inline script 後落地 nonce/hash based CSP，至少含 `default-src 'self'`、精確的 `script-src`／`style-src`／`connect-src`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`；實際 directive 依地圖資源清單收斂，不直接複製範例。
- 保持 domain modules 不依賴 DOM/Leaflet，方便測試與重用。

**驗收標準**

- `src/ui.ts` 不再承載大段未型別化 browser JS。
- CSP report-only 無預期外 violation 後再 enforcement。
- 模組拆分不改 API contract；每一小步都可獨立部署／回滾。

#### P5-3：錯誤恢復與 accessibility

**修改內容**

- 所有 skeleton 都有 success／empty／error／aborted terminal state 與 retry action。
- BYOK input 使用真正 `<label>`、說明與錯誤關聯；狀態更新使用合適的 `aria-live`。
- modal／drawer 管理 focus trap、返回 focus、Escape；所有 icon-only action 有可見或 accessible name。
- 修正白字／coral 等不足的對比，核心功能在手機不只顯示 `▦`／`↗` 圖示。
- `prefers-reduced-motion` 關閉 shimmer 與非必要動畫。
- setup 頁 noindex，補 canonical、OG image、Twitter card 與 sitemap 邊界。

**驗收標準**

- 鍵盤可完成主要使用流程；axe 無 critical/serious violations。
- 失敗不會留下無限 loading；使用者能理解發生什麼並重試。
- 文字與控制項符合 WCAG AA 對比目標。

## 6. 建議的 PR 切分與依賴順序

不要做一個巨型整改 PR。建議順序如下：

| PR | 內容 | 依賴 | 可獨立回滾 |
| --- | --- | --- | --- |
| PR-00 | Edge HTTPS／TLS 操作、驗證腳本、runbook | 無 | 是，HSTS 除外，故需 staged rollout |
| PR-01 | Worker 308、安全標頭基線、CSP report-only groundwork | PR-00 | 是 |
| PR-02 | body/schema/rate limit、TDX timeout/single-flight、BYOK cache fingerprint | PR-01 | 是，門檻以設定控制 |
| PR-03 | CI quality gate、secret scope、Action SHA、Node/typegen | 無，可與 PR-01/02 平行開發 | 是 |
| PR-04 | `RoutePatternRef`、API dual-read、favorites migration | PR-03 測試護欄 | 是，保留 v1 讀取 |
| PR-05 | Journey ETA/schedule、stale request、nearby、轉乘呈現 | PR-04 | 分功能 flag 回滾 |
| PR-06 | Snapshot validator、atomic publish、smoke、rollback、告警 | PR-03；需理解 PR-04 schema | 是，previous pointer |
| PR-07 | Network LOD、payload budget、Web Worker | PR-06 validation | 是，LOD/schema flag |
| PR-08 | Workers integration、Playwright 擴充、browser script 外移、CSP enforcement、a11y | PR-03；可分多個小 PR | 是 |

建議先讓 PR-03 的 CI 護欄落地，再進行大範圍正確性與資料 schema 修改。PR-00 的 Dashboard 操作可立即做，但要把實際值、操作者、時間與驗證結果補回 runbook。

## 7. 每個 PR 的共同完成定義

每個 PR 至少要符合：

- [ ] 風險 ID、變更範圍、API/schema 相容性寫進 PR 描述。
- [ ] `npm test` 通過。
- [ ] `npm run typecheck` 通過。
- [ ] production Vite build 通過。
- [ ] Wrangler deploy dry-run 通過。
- [ ] `wrangler types --check` 通過（PR-03 落地後成為硬門檻）。
- [ ] 新增／修改路由有 Workers runtime integration test。
- [ ] 修改 browser flow 有 Playwright success、error 與 stale-response case。
- [ ] `npm audit` 無新增 high/critical vulnerability。
- [ ] snapshot schema 修改通過 22 城市 validation 與 smoke test。
- [ ] 安全／效能／資料變更附 rollback 步驟，並在 staging 或測試 namespace 演練。
- [ ] 部署後檢查 4xx/5xx、upstream error、fallback rate、payload budget 與 snapshot freshness。

## 8. 發布與相容策略

### API／資料 schema

- 新增 `schemaVersion`，採 additive change 優先。
- `RoutePatternRef` 至少一個發布週期 dual-read；新 client 先部署，再停止舊欄位寫入，最後才移除舊讀取。
- snapshot object 使用 immutable versioned key；active pointer 小且可原子切換。
- 保留 previous pointer 與已知良好 object，直到新版本通過觀察期。

### 前端

- LOD、新 journey 計算與重大 state coordinator 以小範圍 feature flag/city allowlist 開啟。
- localStorage migration 必須冪等，可重跑，不刪原始資料直到新格式穩定。
- service/browser cache key 包含資產與 schema version，避免新舊 bundle 混用。

### 觀測指標

不蒐集可識別個人的精確位置或 BYOK credential。建議只做匿名聚合：

- API status/latency、TDX upstream error、429、timeout、snapshot fallback rate。
- 各城市 snapshot age、size、route/stop/coordinate count 與 publish outcome。
- 全路網 payload、client parse/index time bucket、long task count。
- stale request aborted count、UI empty/error/retry count。
- journey partial/degraded rate與 ETA source 分布。

## 9. 立即操作清單

在正式寫功能前，可先完成以下低風險高報酬項目：

- [x] Cloudflare 開啟 Always Use HTTPS。
- [x] Minimum TLS 設為 1.2。
- [x] 以短 `max-age` 啟用 HSTS，記錄提升時間表。
- [x] 建立 edge/security runbook 並保存 `curl`／OpenSSL 驗證結果。
- [x] 將 GitHub workflow secrets 收斂到 step scope。
- [x] 新增 PR/push CI，鎖住 tests、typecheck、build 與 dry-run 基線。
- [x] 修好 `wrangler types --check`，再開始 schema 重構。
- [ ] 為 route pattern identity 先建立失敗 fixture，不先改 production 邏輯。
- [ ] 把 snapshot validator 設計成 publish 的必要條件，而不是只發 warning。

## 10. 產品方向建議

### 應該加深的差異化

- **站點是網路節點**：把站點可達路線、轉乘關係、方向與即時可靠性做深。
- **通勤者一眼可懂**：常用站牌／路線、下一班、異常與資料新鮮度在最短操作內可見。
- **城市路網理解**：把全路網與旅程規劃變成清楚 CTA，而不是藏在 icon 裡。
- **公共資料信任**：直接顯示 `source`、`updatedAt`、snapshot age、partial/degraded，不製造假精確。

### 現階段不建議

- 不為了「架構看起來更大」拆微服務；Workers + D1/R2 足以支撐目前產品，先補護欄與正確性。
- 不急著複製 Google Maps 的全功能導航；那會稀釋專案真正有辨識度的公共運輸網路視角。
- 不在沒有真機量測前全面改寫 renderer；先用 LOD 取得最大效益，再用數據決定是否上 vector tiles。
- 不用追蹤精確位置換取表面上的分析能力；以匿名聚合可靠性指標維持產品的 no-tracking 信任。

## 11. 其他待辦

- README 的 Node 版本與實際 Wrangler engine 對齊。
- README 圖片由約 1.79 MB PNG 改成 WebP/AVIF。
- 將 `sync-chiayi-snapshot.mjs` 改成符合 22 城市現況的通用名稱。
- 補 `SECURITY.md`、貢獻指南、資料與部署 runbook。
- 檢查 `homeNotice` 使用 `in` 的 prototype-chain 風險，改用 `Object.hasOwn()`。
- 對 radius／lat／lon 做有限值與範圍驗證。
- localStorage 所有讀取都做 schema validation 與 migration failure fallback。
- 檢查第三方地圖、字型、圖示與資料 attribution／license notice。

## 12. 決策紀錄

1. **保留 immutable snapshot 模型**：問題是缺 publish gate，不是模型本身錯誤。
2. **先修正 route pattern identity，再修 Journey ETA**：否則 ETA 修得再漂亮，輸入 identity 仍可能錯。
3. **先補 CI/runtime tests，再大改 schema**：讓相容性和 Cloudflare binding 行為可被自動驗證。
4. **先 Network LOD，再評估 tiles**：本輪 50 m 實驗已證明能以小變更取得數量級改善。
5. **安全設定採分階段 rollout**：HTTPS/TLS 立即做；HSTS 因 client cache 不易回滾，必須漸進。
6. **正確呈現不確定性**：即時資料不足時顯示範圍、來源與 degraded 狀態，不輸出假精確時間。

---

### 更新規則

- 每個修正 PR 在風險登錄表更新狀態：`Open → In Progress → Verified → Closed`。
- `Verified` 必須附測試、部署版本與驗證證據；只有程式碼合併不能直接標 `Closed`。
- 發現新問題時新增穩定 ID，不重新編號既有項目。
- 效能數據須標示環境與日期；Node 合成量測與真機 Web Vitals 分開記錄。
