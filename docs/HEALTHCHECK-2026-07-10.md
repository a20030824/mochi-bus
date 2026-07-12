# Mochi Bus 健檢紀錄與整改計畫 — 2026-07-10

> 本文件是 2026-07-10 深度健檢的可追蹤紀錄，也是後續修改的執行藍圖。
> 狀態：**整改進行中；Phase 0、Phase 1 護欄、Phase 2 route/journey correctness 與 Phase 3 快照發布安全已部署驗證；Phase 4（全路網 LOD 第一步）與 Phase 5（Workers 測試、setup 頁模組拆分、a11y、SEO）已各起步一輪，細節見對應風險 ID 的 In Progress 紀錄與備註的剩餘項目**。

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
| COR-001 | P0 | 子路線識別遺失，可能混用 ETA／班表／收藏 | `src/domain/route-pattern.ts`、`src/lib/tdx.ts`、`src/domain/favorite-board.ts`、`src/routes/bus.ts` | Phase 2 | Verified：RouteUID/SubRouteUID/pattern identity 全鏈路已部署 `28b347d8-…` |
| COR-002 | P0 | Journey ETA 用第一筆而非最佳 ETA，班表跨 route flatten | `src/domain/map/journey-estimate.ts`、`src/routes/map.ts`、`src/infrastructure/transit/snapshot-repository.ts` | Phase 2 | Verified：route/subroute-scoped ETA 與 schedule 聚合已部署 `91b1bdfc-…` |
| DATA-001 | P0 | 快照發布前缺 schema／數量／引用完整性驗證與自動回滾 | `scripts/transit-snapshot/*`、`scripts/sync-transit-snapshot.mjs`、`docs/operations/transit-snapshot-publishing.md` | Phase 3 | Verified：gated publish 與 rollback 往返已用 Chiayi production snapshot 驗證 |
| PERF-001 | P1 | 大型城市全路網 payload、parse、index 與記憶體過高 | `web/map/main.ts:1112-1153`、`scripts/sync-transit-snapshot.mjs:328` | Phase 4 | In Progress：network.json LOD 容差已提高至 50m 並在 Chiayi production 驗證瘦身；Web Worker offload 與大型城市真機量測仍 Open |
| COR-003 | P1 | 路線、路網、附近站牌與地點請求存在 stale response race | `web/map/main.ts:864-905,1112-1124,1256-1301,1924-2008`；`src/ui.ts:395-397` | Phase 2 | Verified：共用 nav-request coordinator 已部署 `ef8eefaf-…` |
| SEC-002 | P1 | 公開重型 API 缺 body size、runtime schema、rate limit 與併發保護 | `src/rate-limit.ts`、`src/lib/tdx.ts`、`src/routes/map.ts:450-532` | Phase 1 | Verified：input boundaries、per-location edge rate limit、single-flight 與 credential-scoped circuit breaker 已部署 `8fa1fd3d-…` |
| SEC-003 | P1 | BYOK token cache 僅以 clientId 分桶，secret 長期存在 localStorage | `src/lib/tdx.ts`、`web/boards/store.ts:135-305`、`src/ui.ts:331-407` | Phase 1 | Verified：server fingerprint/LRU 與 session-first browser lifecycle 已部署 `b71d9105-…` |
| CICD-001 | P1 | CI secret scope 過大、Actions 用 mutable tag、缺 PR/push quality gate | `.github/workflows/sync-transit.yml:24-33,72-74` | Phase 1 | In Progress：本地 workflow 驗證通過；待 push 後首次 CI run 與 Environment 保護 |
| TEST-001 | P1 | 缺 Cloudflare Workers runtime 與瀏覽器整合／競態測試 | `vitest` 現況與測試目錄 | Phase 1-5 | In Progress：`@cloudflare/vitest-pool-workers` 已納入 CI 覆蓋 middleware/body-limit；瀏覽器 Playwright／axe 仍 Open |
| COR-004 | P1 | 轉乘時間使用固定假設卻呈現精確分鐘，且未納入步行距離 | `src/domain/map/transfer-estimate.ts`、`web/map/main.ts` | Phase 2 | Verified：時間範圍、步行與候車不確定性已部署 `c298089c-…` |
| ARCH-001 | P2 | 大量 browser JS 內嵌字串未被完整 typecheck/lint，地圖主檔過大 | `src/ui.ts:63-285,379-408`、`web/map/main.ts` | Phase 5 | In Progress：setup 頁腳本已搬到 `web/setup/main.ts` 並納入 TypeScript/build;ETA 頁 inline script 與 `web/map/main.ts` 拆分仍 Open |
| QUERY-001 | P2 | nearby 先在 bbox 無排序 `LIMIT 100`，高密度區可能漏掉真正最近站牌 | `src/infrastructure/transit/snapshot-repository.ts`、`src/infrastructure/transit/snapshot-repository.test.ts` | Phase 2 | Verified：完整 bbox 候選經 Haversine 排序後才取最近 100；已部署 `f6c08bfb-…` |
| CACHE-001 | P2 | Cache API write 位於回應關鍵路徑，cache failure 可能拖累或弄壞主請求 | `src/lib/edge-cache.ts`、`src/lib/tdx.ts`、`src/routes/map.ts` | Phase 1 | Verified：背景寫入與 read/write fail-open 已部署 `19229db5-…` |
| PIPE-001 | P2 | token fetch 無 timeout/retry，Retry-After 解析有陷阱，單城失敗中止整批 | `scripts/sync-transit-snapshot.mjs:22-54`、`.github/workflows/sync-transit.yml:72-74` | Phase 3 | In Progress：token fetch 與資料 fetch 已共用 timeout/retry/Retry-After 修正；單城失敗隔離在目前 workflow 已是既有行為。細節見 Phase 3 下方 2026-07-12 紀錄，尚待下一次排程/手動 dispatch 的實際執行驗證 |
| DX-001 | P2 | Node 版本文件與 Wrangler 要求不一致，bindings typegen 不可重現 | `README.md`、`.dev.vars`、`worker-configuration.d.ts` | Phase 1 | Verified：Node ≥22／CI 24 LTS；deterministic typegen check 通過 |
| A11Y-001 | P2 | 表單 label、錯誤恢復、focus、live region、對比與 reduced motion 不完整 | `src/ui.ts:332-335`、`src/map-page.ts:39-40`、`web/map/style.css` | Phase 5 | In Progress:live region／reduced motion／setup picker 的 Escape+focus 已修;skeleton retry action 與 BYOK 錯誤關聯已補(細節見下方 2026-07-12 紀錄);primary button 對比是品牌色決策,需設計覆核才能動,仍 Open |
| SEO-001 | P3 | canonical／OG image／Twitter card／setup noindex 等仍可補強 | `src/seo.ts`、`src/ui.ts`、`src/map-page.ts` | Phase 5 | In Progress:setup noindex 與 OG image/Twitter card 已補;canonical/og:url 已補(細節見下方 2026-07-12 紀錄) |

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

> 2026-07-11 Nearby correctness 結果：commit `47e72b8` 已 100% 部署為 `f6c08bfb-4b45-4f24-a1bb-d62c5ba77d1e`，前一版 `19229db5-4894-42ed-b674-1a32c6cf9ed2` 可直接回滾。bbox SQL 移除無序的前置 `LIMIT 100`，保留 `(version, city_code, latitude, longitude)` 複合索引縮小候選，Worker 再以 Haversine 精確距離過濾、穩定排序並於最後取最近 100。新增 101 筆高密度 regression fixture，確認排在資料庫第 101 筆的最近站不會遺漏。Production D1 `EXPLAIN QUERY PLAN` 確認使用 `stop_places_geo_idx`；台北 2 公里樣本 bbox 有 271 候選、SQL 約 2.01 ms。22 個測試檔、152/152 tests、typegen、TypeScript、build、dry-run 全數通過；線上 nearby 回 200／100 筆／距離遞增／全在半徑內，約 0.33 秒，首頁與 HSTS/CSP 正常。QUERY-001 標記 Verified。

> 2026-07-11 Transfer grid correctness 結果：commit `eef83a9` 已 100% 部署為 `ffbbe463-31ab-43f2-9c89-98368b80b63a`，前一版 `f6c08bfb-4b45-4f24-a1bb-d62c5ba77d1e` 可直接回滾。固定角度網格改為依緯度與 350 m 球面半徑動態計算鄰格跨度；約北緯 26.4° 時會掃到相隔兩個 longitude cells 的候選，最終仍以 Haversine 嚴格排除超過 350 m 的配對。新增北部兩格內／外邊界 regression tests；台灣北端每個 forward candidate 的 bucket lookup 由 9 格增至最多 15 格，整體仍為網格索引的近線性成本。22 個測試檔、154/154 tests、typegen、TypeScript、build、dry-run 全數通過；production「嘉義火車站 → 慈濟靜思堂」轉乘 API 回 200／5 個方案／約 0.56 秒，首頁與 HSTS/CSP 正常。P2-4 的 grid 子項完成，COR-004 的 ETA 呈現仍維持 Open。

> 2026-07-11 Honest transfer estimate 結果：commit `2bd6dd1` 已 100% 部署為 `c298089c-7ca4-4005-8715-09a2048c1484`，前一版 `ffbbe463-31ab-43f2-9c89-98368b80b63a` 可直接回滾。移除每站固定 2 分鐘與接不上就加 20 分鐘的單點假精度；新純 domain model 以站數區間與 60–90 m/min 步行速度產生「車程＋步行」範圍，並將 2 分鐘 ETA uncertainty 與 2 分鐘安全轉乘 buffer 納入銜接判斷。只有兩段即時 ETA 足以支持安全銜接時才顯示總時間範圍；偏趕、可能錯過或缺資料時明確標示未推測下一班候車，且所有粗估都揭露未含路況。可銜接方案優先排序，不再以武斷魔法數字排序。23 個測試檔、160/160 tests、typegen、TypeScript、build、dry-run 全數通過；production deployment 100%，map asset 已確認含新範圍／不確定性文案且不含舊 `+20`／`comfortable` 邏輯，transfer API、地圖頁與 HSTS/CSP 正常。COR-004 標記 Verified，P2-4 完成。

> 2026-07-11 Journey identity correctness 結果：commit `ca924b0` 已 100% 部署為 `91b1bdfc-0e43-442a-800e-1572e2a2b89c`，前一版 `c298089c-7ca4-4005-8715-09a2048c1484` 可直接回滾。Journey realtime 不再對混合陣列取第一筆，改用既有 best-ETA ranking 並以 `RouteUID + SubRouteUID + direction + stopUid` 篩選；TDX fetch 與 schedule fallback 均按 `RouteUID` 去重／分桶，同名不同路線不再互借。repository 直接查出 `subroute_uid`，移除從 `patternId` 字串猜 identity；snapshot schedule 在提供 `RouteUID` 時會先向 active D1 version 驗證，再讀對應 R2 object。單一路線 realtime 或 schedule 失敗會結構化記錄並只讓該 leg 回 `source:none`，其他路線繼續。24 個測試檔、164/164 tests、typegen、TypeScript、build、dry-run 全數通過；production 真實兩段轉乘 Journey ETA 回 200／2 estimates，一段 `none`、另一段 `schedule:57`，證明部分缺資料不互相污染，地圖頁與 HSTS/CSP 正常。COR-002 標記 Verified。Response-level `partial/degraded` 摘要與 `updatedAt` 仍可在後續 API contract 強化時新增，目前每個 estimate 已有 `source`。

> 2026-07-11 Route pattern identity 結果：commit `c92f5dc` 已 100% 部署為 `28b347d8-9fc2-4073-98e5-c336c1813645`，前一版 `91b1bdfc-0e43-442a-800e-1572e2a2b89c` 可直接回滾。新增共用 `RoutePatternRef`／穩定 key，將 `RouteUID + SubRouteUID + patternId + direction` 傳過 TDX catalog/stop groups、snapshot D1/R2 repository、API、canonical URL、地圖變體與 favorites；同名不同 RouteUID 不再被 catalog/realtime batch 合併，同站序不同 SubRouteUID 也保留為不同選項。舊 favorite 採 dual-read，缺 RouteUID 或地圖 patternId 時標記 `legacy-ambiguous`，只有唯一候選才自動補齊，否則提示重新選擇。25 個測試檔、171/171 tests、typegen、TypeScript、build、dry-run 與 npm audit（0 vulnerabilities）全數通過。Production 100%；首頁、setup、boards asset、routes/stops API 與 HSTS/CSP 正常。真實嘉義中山幹線回傳 `CYI071401`、`CYI0714A1`、`CYI0714B1` 等獨立變體；同方向共站但缺 SubRouteUID 的舊 URL 回 409，不再任意取第一條，補上 SubRouteUID 後 canonical redirect 302 → 200。COR-001 標記 Verified。

> 2026-07-11 Snapshot publication safety 結果：commit `d3ebada`（rollback legacy credential follow-up `a595cd7`）的 Worker 觀測欄位已 100% 部署為 `be88a657-ce9c-4d7a-b3e0-389de1fb7c51`。發布流程改為 generate → local validate → immutable R2/D1 stage → remote counts/reference/manifest validate → 單一 D1 statement activate → cache-busted public API smoke → state/cleanup；pointer 切換前不刪舊版，smoke 失敗會自動恢復 previous，跨城市 workflow 會收集所有失敗再結束。Validator 拒絕空資料、超過 40% 數量暴跌、非法台灣座標、破損 shape、重複站序及所有 route/pattern/stop/place/network 懸空引用；每版 manifest 記錄 checksum、bytes、source、generatedAt、workflow run 與 counts。27 個測試檔、178/178 tests、typegen、TypeScript、build、dry-run 與 npm audit（0 vulnerabilities）全數通過。受控 Chiayi production publish `20260711T120518025Z` 通過 66 routes、273 patterns、3,106 stops、1,170 places、11,844 pattern-stop references 的 local/remote gate 與 66-route public smoke；previous `20260708T233947672Z` 保留。隨後執行新 → 舊 → 新 rollback 往返，兩次 smoke 均成功，最終 D1 與公開 API active version 都是 `20260711T120518025Z`。DATA-001 標記 Verified；操作與故障處理見 `docs/operations/transit-snapshot-publishing.md`。

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

> 2026-07-11 核心正確性完成：亂序 ETA、同名不同 route/subroute、跨 route schedule 污染與無 fallback source 測試均通過；production 部分缺資料時仍保留其他 leg。每筆 estimate 已提供 `source`，response-level `partial/degraded` 摘要與 `updatedAt` 留待 API schema additive change。

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

> 2026-07-11 stale response 防護結果：commit `a4e47ac` 已部署為 `ef8eefaf-4e98-4d49-8626-14c57989057c`（100%），前一版 `19229db5-…` 可直接回滾。新增純邏輯 `src/domain/map/nav-request.ts` 共用 coordinator：每次呼叫 `begin()` 換發新 epoch 並 `abort()` 前一輪還沒完成的 fetch,`isStale(requestId)` 讓任何比目前 epoch 舊的回應安靜作廢。`chooseCity`、`loadRoute`、`toggleCityNetwork`、`findNearbyPlaces`、`showPlaceRoutes`、`loadDirectRoutes`、`showTaiwan` 皆已接上,fetch 傳入對應 `signal`；stale 分支不更新 `routes`／`lastNearbyPlaces`／drawer／`history.replaceState`／document title,catch 內同樣先判斷 stale 才顯示錯誤,不會為使用者已經離開的請求彈錯誤 toast。全路網 fetch(單城市可達 35 MiB)在超車時會被真的 `abort()`,不只是忽略結果,同時省頻寬。`src/ui.ts` 的 `/setup` 城市／路線／站牌三段式選擇也補上同款 request id 防護。28 個測試檔、182/182 tests(新增 4 個 coordinator 單元測試,包含「A 慢、B 快」情境)、typegen、TypeScript、build、dry-run 與 `npm audit`（0 vulnerabilities）全數通過。Production 首頁、cities、Chiayi routes/nearby 均回 200,部署後的 `map.js` 已確認含新 coordinator 邏輯,HSTS/CSP/`X-Frame-Options` 正常。COR-003 標記 Verified；尚未補 Playwright out-of-order response 的瀏覽器整合測試,留給 TEST-001。

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

> 2026-07-11 P2-4 完成：完整 bbox 候選經精確距離排序後才 limit；轉乘候選格數依緯度動態擴張；時間改為納入步行的可解釋範圍，候車或路況未知時明確揭露，不再補固定 20 分鐘。高密度、北部 grid 邊界與估算資料品質測試，以及 production query plan、nearby／transfer／asset smoke 均通過。

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

> 2026-07-12 PIPE-001 timeout/retry 結果：`scripts/sync-chiayi-snapshot.mjs` 新增共用 `fetchWithTimeout`/`fetchWithRetry`(15 秒逾時、最多 5 次嘗試、指數退避)，token fetch 與既有的 `tdxGet` 資料端點改用同一套邏輯，不再有「token fetch 失敗就讓整個城市直接中止、沒有重試機會」的落差。同時修正 `Retry-After` 解析陷阱：header 缺席時舊寫法 `Number(null)`(值是 0)會被 `Number.isFinite` 誤判成「有效的 0 秒」，對著還在限流的 TDX 立刻重打；新版先判斷 header 是否存在，缺席才退回指數退避。單城失敗中止整批的部分：確認目前 `.github/workflows/sync-transit.yml` 的城市迴圈已經是 `for city in $cities; do ... done` 搭配收集 `failed` 清單、跑完才統一回報，單一城市失敗不會擋掉其他城市，這部分已是既有行為，不需要額外修改。`node --check` 語法驗證通過，`npm test`(30 個測試檔、201/201)、typecheck、build、`wrangler deploy --dry-run` 全數通過；這支腳本本來就沒有單元測試覆蓋(需要真實 TDX 憑證才能執行)，這輪也沒有對著真正的 TDX API 或排程跑一次完整驗證，PIPE-001 維持 In Progress，留到下一次排程或手動 `workflow_dispatch` 執行時觀察是否如預期重試/逾時。

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

> 2026-07-11 network geometry LOD 第一步結果：commit `866f14b` 已部署為 `88a9ba3b-4dcf-4d81-9785-e0bcc8ea501b`（100%），前一版 `ef8eefaf-…` 可直接回滾；不需要 schema version bump 或 dual-read——座標數量／精度改變對 client 完全透明(`L.geoJSON`／`buildNetworkIndex` 都是泛型消費座標陣列),新舊 snapshot 混用不會壞。把 sync 腳本既有的 Douglas-Peucker 簡化(`scripts/sync-chiayi-snapshot.mjs` 產生 `network.json`)容差從 8m 提高到 50m,對應本次健檢自己做過的唯讀量測;同一容差也補進 `snapshot-repository.ts` 的小城市 inline fallback(沒有預生成 `network.json` 的城市)。新增可單元測試的 `src/domain/map/simplify.ts`(Douglas-Peucker,6 個測試)取代原本散落各處的重複實作。透過 `gh workflow run sync-transit.yml -f city=Chiayi` 走完整 generate→validate→publish→smoke 閘門,實際重新發布 Chiayi(`20260711T230007001Z`,前一版 `20260711T120518025Z`),production 量測：`network.json` 從 1,322,185 bytes 降到 620,335 bytes(**-53.1%**,273 個 pattern、21,739 個座標);Chiayi 路網本身線形較單純,幅度小於健檢對雙北的唯讀量測(35.75 MiB→3.01 MiB,-93.5%),雙北等大城市要等排到的排程或手動 dispatch 重新產出才能量到對應數字。29 個測試檔、189/189 tests、typegen、TypeScript、build、dry-run 與 `npm audit`（0 vulnerabilities）全數通過；production 首頁、cities、Chiayi routes/nearby/network 均回 200,HSTS/CSP 正常。PERF-001 標記 In Progress：payload/parse 的第一步已驗證且對舊 snapshot 向後相容,但 P4-1 其餘項目(metadata 與 geometry 分離、Web Worker offload、CI payload budget、大型城市與真機 CWV 量測)與 P4-2(vector tiles spike)仍是 Open,留待下一輪。

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

> 2026-07-11 Cloudflare Workers runtime 整合測試結果：commit `50223c8` 已推送並在 GitHub Actions CI 通過。新增 `@cloudflare/vitest-pool-workers` 作為第二個 Vitest project(`test/workers/**`,透過根目錄 `vitest.config.ts` 的 `test.projects` 分流,vitest 4 已移除獨立 `vitest.workspace.ts`,改用單一 config 內的 `projects` 陣列),既有 domain/lib 純邏輯測試留在原本的 Node 環境專案,互不拖慢也互不影響環境限制。新測試用 `SELF.fetch()` 在真正的 workerd runtime 裡驗證 HTTP→HTTPS 308 redirect、HSTS/CSP/X-Frame-Options 安全標頭、靜態 `/api/v1/map/cities`,以及 `journey-eta` 的 Hono `bodyLimit` 413——這些 middleware 語意在純 Node 環境從來測不到。安裝這個套件把 `wrangler`／`workerd` 透過依賴解析帶到更新版本,連帶讓 `wrangler types --check` 偵測到落差,已重新產生 `worker-configuration.d.ts`(diff 只是 Email reply builder、Workflow dynamic delay 等跟本專案 bindings 無關的環境型別新增)。30 個測試檔、195/195 tests(新增 6 個 workers-runtime 測試)、typegen、TypeScript、build、dry-run 與 `npm audit`（0 vulnerabilities）全數通過,CI 在 ubuntu-latest 上一樣綠燈,不需要修改 `.github/workflows/ci.yml`(`npm run check` 已經涵蓋兩個 project)。這是 dev/test 工具鏈變更,沒有新增或修改服務給使用者的 runtime 行為,因此沒有另外執行 production deploy。TEST-001 標記 In Progress：Workers runtime 整合測試已落地,API contract dual-read 測試、Playwright 瀏覽器整合(城市/路線切換、BYOK setup、收藏 migration、out-of-order response)、axe accessibility 與 performance budget 仍是 Open,留待下一輪——Playwright 需要安裝瀏覽器並起 dev server 跑真實互動,這輪沒有嘗試。

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

> 2026-07-11 setup 頁腳本外移結果:commit `90f0b81` 已部署為 `372af754-1939-416d-aeec-8e3a2bf2677d`(100%),前一版 `88a9ba3b-…` 可直接回滾。`/setup` 的路線/方向/站牌 picker、常用站牌 CRUD、BYOK 憑證 UI 從 `src/ui.ts` 裡一段未型別化的 template literal 搬到 `web/setup/main.ts`,由 Vite 建成 `/assets/setup.js`;`src/ui.ts` 現在只吐 script 標籤。過程中發現 `worker-configuration.d.ts` 為 HTMLRewriter API 宣告的全域 `Element` 會跟 lib.dom 的 `Element` 合併,汙染任何用到 `querySelector<T>()`/`.append(...)` 的檔案——改用 `as` cast 與 `.replaceChildren()`/`.appendChild()`,跟既有 `web/map/main.ts` 同一套規避方式。用 Playwright 對著 `wrangler dev` 實際跑過 picker→方向→站牌→建議的完整流程時,抓到一個真實存在(非本次引入)的競態:`hidePicker()`/`backToRoutes()` 只清空 `selectedRoute`、沒有搶新 epoch,使用者在 `loadSuggestions` 的 fetch 還沒回來前關掉 picker,fetch 回來後會通過「沒有更新」的舊檢查卻讀到已清空的 `selectedRoute`,丟出 `TypeError`;已補上 `requestId += 1` 修正,並用刻意延遲 fetch 的 Playwright 測試證實修正前會重現、修正後不會。新增 `@playwright/test` 作為手動的 `npm run test:e2e`(不進 `npm test`/`check`/CI,瀏覽器安裝成本要不要攤進每次 push 是另一個決定),含這次的競態回歸測試與一個 golden path 測試。30 個測試檔、196/196 tests、typegen、TypeScript、build、dry-run 與 `npm audit`(0 vulnerabilities)全數通過,Playwright e2e 2/2 通過。Production 首頁、`/setup`、`/assets/setup.js` 均回 200,頁面內確認新的 script 標籤,HSTS/CSP 正常。ARCH-001 標記 In Progress:setup 頁完成,ETA 頁(`renderETAPage`)的 inline script 因帶有伺服器端注入資料(`initialBoard`/`tdxWarningMessages`),需要額外的資料傳遞機制才能同樣外移,加上 `web/map/main.ts` 本身的模組拆分,都留給下一輪。

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

> 2026-07-11 A11Y-001 第一輪結果:commit `dc1dfd5` 已部署為 `ee7003b7-53fe-441b-bf15-f8464638640e`(100%),前一版 `372af754-…` 可直接回滾。三個具體缺口:(1)`#map-status` 每次切城市/路線都會更新文字,卻沒有 `aria-live`,螢幕報讀者完全聽不到狀態變化(`#map-drawer` 早有,`#map-status` 沒有),已補上 `aria-live="polite"`。(2)`prefers-reduced-motion` 只關掉 `transition`,沒關 `animation`——`web/map/style.css` 的 route-loading shimmer 與 ETA/setup 頁所有 hover/collapse transition 對「已明確要求減少動態效果」的使用者仍持續播放,已在兩處補上 `animation:none!important`。(3)`/setup` 的路線 picker 行為上等同全頁 modal,原本沒有鍵盤退出路徑也不管理 focus:新增 Escape 關閉、開啟時 focus 移進 picker(`#city`)、關閉時 focus 還給觸發按鈕(`#add-board-button`),並用 Playwright 測試鎖住這個行為。30 個 vitest 測試檔、196/196 vitest tests,加上 3 個 Playwright e2e(golden path、race regression、新增的 Escape/focus 測試)全數通過,typegen、TypeScript、build、dry-run 與 `npm audit`(0 vulnerabilities)也過。Production 首頁、`/map`、`/setup` 均回 200,`#map-status` 的 `aria-live` 與 `map.css` 的 `animation:none!important` 都在線上確認存在,HSTS/CSP 正常。A11Y-001 標記 In Progress:primary button(白字在 `#df7357` 上)量測約 3.1:1,低於 WCAG AA 一般文字要求的 4.5:1——這是品牌色的視覺決定,沒有在未經設計覆核下自行改色;skeleton 的 retry action、BYOK 錯誤關聯、全站 axe 掃描與 focus-visible 逐一盤點仍是 Open。

> 2026-07-11 SEO-001 第一輪結果:commit `d773e9e` 已部署為 `33657a42-a994-470b-8dcd-fcda8994dce8`(100%),前一版 `ee7003b7-…` 可直接回滾。`/setup` 管理的是單一裝置的本機資料(常用站牌、BYOK 憑證),不該被索引或產生社群預覽卡,補上 `<meta name="robots" content="noindex">`(ETA/route/map 等可分享頁面確認沒有這個標籤)。另外全站原本沒有 `og:image` 與任何 Twitter Card 標籤,聊天軟體/Twitter 爬蟲抓不到圖也抓不到卡片型態;新增共用的 `siteSocialImage`(沿用現成的 180×180 `apple-touch-icon.png`,1200×630 的橫向 banner 需要額外設計,這輪先不做)與 `twitter:card=summary`/`twitter:title`/`twitter:description`/`twitter:image`,套進 `pageShell`(ETA/route/setup)與 `renderMapPage`(地圖頁)。30 個測試檔、199/199 vitest tests(新增 3 個:setup noindex、可分享頁面沒有 noindex、OG/Twitter 標籤存在)全數通過,typegen、TypeScript、build、dry-run 與 `npm audit`(0 vulnerabilities)也過。Production 首頁、`/setup`、地圖頁的 noindex/og:image/twitter card 標籤與 `apple-touch-icon.png` 本身(200)均已線上確認,HSTS/CSP 正常。SEO-001 標記 In Progress:canonical `<link>` 與 `og:url` 需要把目前請求的實際網址傳進 `bus.ts` 好幾個呼叫點,比這輪的疊加式修改更動範圍大,留給下一輪;1200×630 banner 圖與 sitemap 邊界同樣仍是 Open。

> 2026-07-12 A11Y-001 skeleton retry / BYOK 錯誤關聯結果:地圖有 5 處會把 drawer 換成「正在讀取…」loading 畫面的流程(`chooseCity`、`renderRoutePicker` 的補抓分支、`loadRoute`、`findNearbyPlaces`、`showPlaceRoutes`)原本失敗時只更新狀態列文字,drawer 卻停在 loading 畫面不會進入任何 terminal state,使用者除了整頁重新整理沒有別的路可走。新增共用 `retryButton()`,失敗時把 drawer 換成「◯◯讀取失敗」+ 錯誤訊息 +「再試一次」按鈕,重按會用原本的參數重新呼叫同一個載入函式;順手發現 `renderRoutePicker` 的補抓分支原本連 `interactionMode`/`activeCity` 都沒檢查就直接改畫面,補上跟成功分支一致的 staleness guard,避免使用者已經離開這個城市/選單時還被失敗畫面搶回去。BYOK 憑證表單原本 Client ID/Secret 兩個欄位跟共用的 `#tdx-message` 錯誤訊息沒有任何程式化關聯,螢幕閱讀器使用者只能靠肉眼在欄位下方找錯誤;新增 `aria-describedby="tdx-message"`、依錯誤來源切換 `aria-invalid` 並把焦點移到出錯欄位,本機驗證失敗(空白 Client ID/Secret)與遠端驗證失敗(憑證錯誤)分別標記對應欄位。用 Playwright 對著 `wrangler dev` 實際跑過:清空 Client ID 送出 → `aria-invalid=true`、焦點落在 Client ID、訊息「Client ID 不能空白」;補上 ID 留白 Secret → 換成標記 Secret 欄位;兩者都填但憑證錯誤 → 兩個欄位都標成無效並顯示伺服器回傳的錯誤訊息。地圖端攔截 `/api/v1/map/nearby` 回應 500 後點地圖,drawer 正確顯示「附近站牌讀取失敗」+「再試一次」;解除攔截後按重試,drawer 正常收斂到「附近沒有站牌」的空結果終態,沒有卡在錯誤畫面。30 個測試檔、201/201 vitest tests、typegen、TypeScript、build、`wrangler deploy --dry-run` 全數通過。這輪只在本機 `wrangler dev` + Playwright 驗證,還沒有部署到 production,A11Y-001 維持 In Progress:primary button 對比是品牌色決策,仍待設計覆核;全站 axe 掃描與 focus-visible 逐一盤點仍是 Open。

> 2026-07-12 SEO-001 canonical/og:url 結果:`pageShell`(ETA/setup/route/同名站牌 disambiguation 頁共用)與 `renderMapPage` 都補上 `<link rel="canonical">` 與 `<meta property="og:url">`,一律標準化成正式網域 `https://bus.moc96336.com` 加上請求的 pathname/search——不信任 Host header,本機開發或未來的 preview host 也會標準化成同一個正式網址,避免分享卡/搜尋引擎索引到不是正式網址的版本。過程中盤點 `renderETAPage` 對 `pageShell` 的呼叫時發現原本的位置參數設計很脆弱:`script`/`description`/`noindex` 都是可省略的位置參數,一旦有呼叫點漏帶中間某個空字串佔位,後面的參數會整組往前錯位卻不會有任何型別錯誤;這次把 `pageShell` 改成單一必填 `canonical` 的物件參數,連帶排除這類錯位風險,不用等下一次真的漏寫參數才發現。`src/routes/bus.ts` 的 `/`、`/bus`、`/setup`、`/route`(含快照 fallback)、同名站牌 disambiguation 頁,以及 `src/routes/map.ts` 的 `/map`,都改傳入 `c.req.url`。新增測試涵蓋 canonical/og:url 標準化(含本機 host 也要標準化成正式網域)、map 頁沒有 `requestUrl` 時的預設 canonical,以及分享頁應該用路線/站牌專屬的 description 而非首頁通用描述。30 個測試檔、201/201 vitest tests、typegen、TypeScript、build、`wrangler deploy --dry-run` 全數通過;另外對著 `wrangler dev` 用 curl 實測 `/`、`/setup`、`/bus?...`(含經過 canonical redirect 的深連結)、`/route?...`、`/map?city=...`,canonical/og:url 內容與各頁實際請求網址一致,`/bus` 頁的 `<meta name="description">` 也確認顯示路線/站牌專屬文字而非首頁通用描述。同樣還沒部署到 production,SEO-001 維持 In Progress,待部署後補上線上確認;1200×630 banner 圖與 sitemap 邊界仍是 Open。

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
- [x] route pattern identity 與收藏 migration fixtures 已建立，production smoke 已通過。
- [x] snapshot validator 已成為 publish 必要條件，並完成 production publish／rollback 往返演練。

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

- ~~README 的 Node 版本與實際 Wrangler engine 對齊。~~ 已完成(DX-001 一併處理,README 已寫「Node 22+，建議 `.nvmrc` 指定的 Node 24 LTS」，與 `package.json#engines` 一致)。
- ~~README 圖片由約 1.79 MB PNG 改成 WebP/AVIF。~~ 2026-07-12 已完成:一開始用既有的 `sharp`(已在 `node_modules`,不用新增依賴)把 `docs/image/hero-map.png`(1,792,561 bytes)轉成新的 WebP,結果發現 `docs/image/hero-map.webp` 其實 2026-07-06 commit `4d354ae` 就已經生成並提交過(202,358 bytes),只是 README 圖片連結一直沒接上、還在用 PNG——多餘的資產躺在 repo 裡沒人用。改用回這個既有版本(比重新生成的還小),README 連結指到 `.webp`,刪除 1.79 MB 的舊 PNG(**-88.7%**)。
- ~~將 `sync-chiayi-snapshot.mjs` 改成符合 22 城市現況的通用名稱。~~ 2026-07-12 已完成:`git mv` 成 `scripts/sync-transit-snapshot.mjs`,同步更新 `package.json` 的 `snapshot:chiayi`/`snapshot:city`、README、`snapshot-repository.ts` 的兩處註解引用；`node --check` 語法驗證通過，205/205 vitest tests、typecheck、build、dry-run 全數通過(workflow 只透過 `npm run snapshot:city` 呼叫，檔名變動不影響 `.github/workflows/sync-transit.yml`)。
- ~~補 `SECURITY.md`、貢獻指南、資料與部署 runbook。~~ 2026-07-12 已完成:新增 `SECURITY.md`(GitHub 私密 Security Advisories 回報流程、範圍內/外說明)與 `CONTRIBUTING.md`(開發流程、`npm run check` 門檻、程式風格、commit 慣例);部署/資料 runbook 原本就有 `docs/operations/edge-security.md`、`docs/operations/transit-snapshot-publishing.md`,此輪只在 README 補上指向這兩份新文件的連結。
- ~~檢查 `homeNotice` 使用 `in` 的 prototype-chain 風險，改用 `Object.hasOwn()`。~~ 2026-07-12 已完成:抽出可單獨測試的 `resolveTDXNotice()`(`src/routes/bus.ts`),改用 `Object.hasOwn()`；新增 `src/routes/bus.test.ts` 鎖住 `constructor`／`__proto__`／`toString`／`hasOwnProperty`／`valueOf` 都不會被誤判成合法 key。程式碼路徑推導:修正前 `?notice=constructor` 會取出 `tdxWarningMessages.constructor`(一個函式而非字串),`renderETAPage` 對它呼叫 `escapeHTML()`→`.replaceAll()` 會丟 `TypeError`;`renderETA` 的外層 catch 重新用同一個壞掉的 `notice` 再呼叫一次 `renderETAPage`,同一個 TypeError 再丟一次,最終落到 `renderPageError(c, error)`,因為 TypeError 不屬於 `QueryValidationError`/`QueryResolutionError`/`TDXServiceError`,回應狀態碼落在 503。嘗試對著 `wrangler dev` 實際重現這個修正前的行為時,被自動防護機制擋下(拒絕把還原成漏洞版本的程式碼跑起來對外服務),因此上述推導未經真正的對外請求驗證,但修正後的版本已對著 `wrangler dev` 實測:`constructor`/`__proto__`/`toString`/`hasOwnProperty`/`valueOf`/合法值 `tdx-quota` 皆回 200,且合法值仍正確顯示對應提示文字。
- ~~對 radius／lat／lon 做有限值與範圍驗證。~~ 已完成(P1-1 API 輸入防護一併處理,見 `src/lib/api-input.ts` 的 `parseCoordinate`/半徑 50–2000 範圍檢查)。
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
