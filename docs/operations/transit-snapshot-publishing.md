# Transit snapshot publishing

快照發布使用 immutable version keys；唯一會改變線上讀取版本的是 D1 `dataset_versions.active_version`。發布工具必須依序完成以下狀態，任何較早階段失敗都不可切換 pointer。

1. Generate：從 TDX 產生 D1 rows、shape、schedule、place bundle 與 network。
2. Local validate：檢查非空、數量暴跌、座標、shape、每個 pattern 至少兩站、序號唯一，以及 D1／place bundle／network 的完整交叉引用；另將班表覆蓋率與 network bytes／座標數和前版比較。
3. Stage：上傳 versioned R2 objects，將新版本 rows 寫入 D1，但仍不可供線上讀取。
4. Remote validate：核對 D1 counts／懸空引用／短 pattern，讀回 R2 manifest，並下載 network、shape、schedule、place 四類關鍵物件的代表樣本核對 bytes 與 SHA-256。
5. Activate：用獨立 D1 statement 原子更新 `active_version`。
6. Verify：以 cache-busted 公開 API 確認 route catalogue 的版本與精確數量、指定 route variant 至少兩站、place bundle 含該 variant，以及 network 串流宣告相同 active version。
7. Finalize：寫入 state metadata，保留 active 與 previous，最後才清理更舊版本。

若公開 smoke 失敗，工具會立即把 pointer 恢復為 previous version；失敗的新版本 artifacts 暫時保留供調查，下次成功發布會清理。

## Commands

本機先由 `.snapshot.env.example` 建立未追蹤的 `.snapshot.env`，不要把 credential 寫入命令列或 commit。

```powershell
npm run snapshot:city -- Chiayi
```

排程 workflow 會讓同批城市全部嘗試完成，再以失敗城市清單結束 job，避免第一個城市失敗後遮蔽其他城市結果。

## Snapshot window outcomes

排程與手動 workflow 透過 `npm run snapshot:window -- <City>` 包裝既有 publisher。runner 不改變 publish gate；它只將 child 的固定 phase marker、terminal result，以及 child 結束後重新讀取的實際 D1 active pointer，寫入：

- `snapshot_window_attempts`：每次 workflow attempt 的 start／terminal 事實。
- `snapshot_windows`：每個 city/window 唯一的 canonical terminal outcome。
- `snapshot_window_completed`：供短期 Workers／Actions Logs 查詢的隱私安全事件。
- GitHub step summary：各城市 published／unchanged／failed 與 durable record write 狀態。

排程 ID 為 `v1:<city>:<Asia/Taipei-date>:0317`，不使用 workflow run ID；GitHub rerun 會找回原 window。手動 dispatch 預設附著最近的 scheduled window，只有選擇 `window_type=manual` 才建立 `v1:<city>:<date>:manual`。`force_publish` 不改 window identity。

時間欄位不可互換：

- `last_source_check_at`：成功取得並判讀本次 TDX source 的時間；unchanged 也會更新。
- `last_published_at`：active pointer 最後成功切換的時間；unchanged 不更新。
- `completed_at`：本次 attempt 結束時間。
- snapshot generated/imported time：artifact 自身年代，不代表本週已成功檢查 source。

durable result 只允許 `published | unchanged | failed`。`missing` 由未來 watchdog 在 07:30 window close 後查無 terminal record 時推導，workflow 本身不可能證明「根本沒有執行」。較新的 failed attempt 可被 rerun 更新為 unchanged／published；已成功的 canonical result 不會被較舊或較低等級 attempt 降回 failed。

### Window record failure runbook

Window event／D1 outcome 寫入與產品 pointer 分離。寫入失敗不得 rollback 已通過 gate 的 snapshot，但該城市與整體 job 仍會標示 `window-record-write-failed`，因為 freshness 證據不完整。

1. 先查 `dataset_versions` 與公開 routes API，確定實際 active version；不要從預期 version 推測。
2. 查該 city/window 的 attempts 與 canonical row；若 attempt 已有 terminal、canonical 缺失，依 GitHub summary 的嚴格欄位重跑同一 workflow attempt，勿手填 raw error。
3. 若 publisher 已成功而只有 record write 失敗，不要盲目 rollback；修復 D1 可用性後 rerun 同一 window，idempotent upsert 會保留成功且不降級。
4. migration step 本身失敗時，本批 publisher 尚未開始，因此不會有 terminal record；保留 workflow failure，交由 A6 watchdog 推導 missing 並重跑。

驗證查詢：

```powershell
npx wrangler d1 execute mochi-transit --remote --command "SELECT city_code, window_id, result, last_source_check_at, last_published_at, active_version, previous_version, failure_class FROM snapshot_windows WHERE city_code='Chiayi' ORDER BY completed_at DESC LIMIT 5"
npx wrangler d1 execute mochi-transit --remote --command "SELECT city_code, window_id, attempt_id, result, started_at, completed_at, failure_class FROM snapshot_window_attempts WHERE city_code='Chiayi' ORDER BY started_at DESC LIMIT 10"
```

### Unchanged active health probe

`source hash unchanged` 現在只是進入唯讀 probe 的條件，不再直接成功退出。只有下列 hard checks 全過，window 才能寫 `unchanged`：

- D1 `dataset_versions.active_version` 存在且為權威。
- active routes/patterns/stops/places/pattern stops 非零，且無 catalogue route 缺 pattern。
- R2 manifest 的 city/version/counts 與 D1 一致，並宣告 network/shape/schedule/place 類 artifacts。
- network HEAD size 符合 manifest，前 64 KiB metadata 宣告同一 city/version。
- public routes schema/source/version/count 正確。
- deterministic route detail 至少兩站。
- deterministic place arrivals 實際使用 active `place-bundle`。

任一 hard failure：window=`failed`、`last_source_check_at` 可更新、`last_published_at` 不更新；不改 active pointer，也不自動 force publish。固定 failure class 可直接在 GitHub summary 或 `snapshot_active_probes` 查詢。

State pointer mismatch、previous 不完整及非核心 rotating shape/schedule HEAD 失敗屬診斷 warning。Current active 全部 hard checks 健康時，window 仍為 `unchanged`，但 probe=`degraded`、`rollback_available=0`，summary 列入 `unchanged-rollback-degraded`。這代表目前服務可用，但復原能力不足，不得標成 active unavailable。

Sample 使用 `SHA-256(city + windowId + probeCaseVersion) % candidateCount`；同 window rerun 可重現、跨週輪替。只保存 `sample_case_id`，不記 route/place/stop identity或 artifact key。雙北 network 只做 HEAD + 64 KiB Range/prefix；bounded reader 在 Range 被忽略時也會取消，不下載、parse 或 index 完整 network。

`network.json` schema v1 的序列化格式契約是頂層前三個欄位固定依序為 `schemaVersion`、`city`、`version`；publisher 以同一 object insertion order 產生 JSON，因此 metadata 必須在開頭數百 bytes 內完整出現。probe 對截斷 token、缺少 metadata 或在 metadata 前插入其他欄位一律 fail closed。若未來 network schema 無法維持此前綴契約，應先新增獨立小型 metadata object 並升級 probe schema，不可只放寬到搜尋任意 64 KiB 內容。

Window terminal 與 probe evidence 由同一 D1 batch寫入：

- `snapshot_probe_attempts`：每個 attempt 的 probe history。
- `snapshot_active_probes`：同 city/window 的 canonical probe outcome；成功或 degraded 時可作為 `unchanged` evidence，若該 window 尚未成功則也可能保留 error outcome。
- `snapshot_probe_completed`：單一整體 probe completion；子檢查不加入分母。

驗證查詢：

```powershell
npx wrangler d1 execute mochi-transit --remote --command "SELECT city_code, window_id, active_probe_result, probe_failure_class, rollback_available, active_version, hard_checks_passed, diagnostic_warnings FROM snapshot_active_probes WHERE city_code='Chiayi' ORDER BY active_probe_at DESC LIMIT 5"
```

`snapshot_windows.result IN ('published','unchanged')` 必須能 join 到同 window 的 `snapshot_active_probes` evidence；published 要求 success，unchanged 允許 success/degraded。Publisher 原有 remote validation／smoke 完成後，會再使用同一 A5b probe留下 published-window evidence；缺 row視為 observation incomplete，不可宣稱 fully observed。

07:30 Asia/Taipei 是 window close；獨立 watchdog 於 07:45（UTC `45 23 * * *`）只讀 D1 推導 missing、failed-active-health與rollback capability，詳見 [snapshot-window-watchdog.md](./snapshot-window-watchdog.md)。每日 22 城 public drift probe留給 A6b。

## Rollback

預設切回 state 中記錄的 previous version：

```powershell
npm run snapshot:rollback -- Chiayi
```

指定仍保留於 D1/R2 的版本：

```powershell
npm run snapshot:rollback -- Chiayi 20260711T000000000Z
```

Rollback 開始時先讀 D1 active pointer。D1 是 current service 唯一權威；若 R2 state.version 與 D1 active 分歧，工具會 fail closed，必須先 reconcile，不能讓 state 決定 current 或 rollback target。權威一致後才確認目標 D1 rows 與 R2 manifest/network，切換後再跑公開 smoke；若 smoke 失敗，會自動恢復原版本。成功後 state 的 active/previous 會互換，因此可以再次執行以復原 rollback。

### Authority mismatch repair path

權威資料分歧時不提供略過完整性檢查的 `--force`。人工修復順序固定為：

1. 查 `dataset_versions.active_version`，以 D1 確認目前線上版本。
2. 以 manifest、network metadata 與核心 D1 counts 驗證指定 rollback target。
3. 依 D1 active reconcile R2 state 的 active／previous metadata；reconcile 前不得修改 active pointer。
4. 重新執行一般 rollback 命令，讓既有 public smoke gate 決定是否切換。

## Failure handling

- Local validation failure：修正上游資料或 validator；沒有遠端寫入。
- Stage/remote validation failure：active pointer 未變；保留 staged version 供調查。
- Smoke failure：確認 log 中有 `phase:"rollback"`，再查公開 routes API 的 `snapshotVersion`。
- Cleanup failure：新版本已通過 smoke；不得盲目 rollback，只需稍後清理多餘 immutable objects。
- State write failure：active version 可能已切換；先查 D1 pointer與公開 API，再決定補 state 或 rollback。

## Verification queries

```powershell
npx wrangler d1 execute mochi-transit --remote --command "SELECT * FROM dataset_versions WHERE city_code='Chiayi'"
curl.exe -sS "https://bus.moc96336.com/api/v1/map/routes?city=Chiayi&snapshot=manual-check"
```

公開回應必須是 `source: "snapshot"`、`snapshotVersion` 等於 D1 active version，且 `routes` 非空。Production smoke 通過前，不得刪除 previous rows 或 objects。

Manifest/state schema v2 會記錄 `counts` 與 `quality`（班表覆蓋、bundle route 數、network bytes／座標數）；任一有前版基準的核心數值下跌超過 40% 就停止在 local validation。Snapshot format 7 會讓每個城市在下一次排程分片各重建一次，確保新版 gate 實際跑過；仍維持每日 D1 寫入分片，不一次重匯全部城市。

## 8m geometry rollback（2026-07-13）

全路網 `network.json` 與 inline fallback 的 Douglas–Peucker 容差統一為 8m。50m 的 payload 實驗雖然減少 bytes 與座標數，但正式路網以視覺正確性優先；本輪不做城市差異化、多層 LOD、tiles 或 Web Worker。

由 production `dataset_versions.imported_at` 與 50m 變更時間交叉確認，原先需要重新生成的 Taipei 與 NewTaipei 已完成 8m production rollout；兩城的 50m active snapshot 均已由新版本取代。其餘城市的 active snapshot 都早於 50m 變更，不列入本次重生清單。

Chiayi 已完成第一站回退與 production 驗證：

| 容差 | Active version | Bytes | 座標數 |
| --- | --- | ---: | ---: |
| 50m（修改前） | `20260712T151455398Z` | 620,381 | 21,739 |
| 8m（修改後） | `20260712T224859683Z` | 1,322,246 | 55,537 |

8m 相較 50m 增加 701,865 bytes（+113.1%）與 33,798 個座標（+155.5%）。Local validation、remote validation、active pointer 切換、公開 routes smoke 均通過；cache-busted production network API 回 200、273 routes，且 version 與 D1 active pointer 一致。

### Taipei 8m production verification

| 項目 | 50m／發布前 | 8m／發布後 |
| --- | ---: | ---: |
| Active version | `20260712T201010854Z` | `20260713T094028731Z` |
| network.json bytes | 3,152,877 | 6,751,228 |
| 座標數 | 114,318 | 287,541 |
| routes | 1,747 | 1,747 |
| places | 3,878 | 3,877 |

- Workflow：<https://github.com/a20030824/mochi-bus/actions/runs/29239937366>
- Workflow head SHA：`85ae5672792f1f3a383d1f54f287ad4ba70a07da`
- Local validation、remote validation、publish、activate 與 public smoke 均成功。
- `network.version` 與 `routes.snapshotVersion` 一致；production network、routes 與 map smoke 均回 200。
- 瀏覽器視覺確認已恢復 8m 線形；未見破碎或嚴重偏移。
- 大型 payload、parse、index 與記憶體問題仍為 Open；本輪沒有宣稱效能或 35MB 問題已解決。

### NewTaipei 8m production verification

| 項目 | 50m／發布前 | 8m／發布後 |
| --- | ---: | ---: |
| Active version | `20260712T201547917Z` | `20260713T101637688Z` |
| network.json bytes | 3,585,200 | 7,727,553 |
| 座標數 | 126,791 | 326,188 |
| routes | 1,740 | 1,740 |
| places | 5,590 | 5,590 |

- Workflow：<https://github.com/a20030824/mochi-bus/actions/runs/29242154743>
- Workflow head SHA：`85ae5672792f1f3a383d1f54f287ad4ba70a07da`
- Local validation、remote validation、publish、activate 與 public smoke 均成功。
- `network.version` 與 `routes.snapshotVersion` 一致；production network、routes 與 map smoke 均回 200。
- 瀏覽器視覺確認已恢復 8m 線形；未見破碎或嚴重偏移。
- 大型 payload、parse、index 與記憶體問題仍為 Open；本輪沒有宣稱效能或 35MB 問題已解決。

本輪只恢復視覺正確性；PERF-001 的大型城市 payload、parse、index 與記憶體問題仍延後處理。不採城市差異化、多層 LOD、tiles 或 Web Worker。
