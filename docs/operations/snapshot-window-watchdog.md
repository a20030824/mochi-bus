# Snapshot window watchdog

這個 watchdog 與 snapshot publisher 分離。Publisher 在 03:17 Asia/Taipei 開始處理當日城市；watchdog 以 07:30 為 window close，GitHub Actions 每日 07:45 Asia/Taipei（UTC cron `45 23 * * *`）判斷該 window 是否留下可信的 durable outcome。它只讀 D1，不呼叫 routes、network、place、journey，也不修改 D1 active pointer、R2 state 或 artifacts。

城市星期排程、Taipei 日期與 `v1:<city>:<date>:0317` identity 只有一份來源：`scripts/transit-snapshot/snapshot-schedule.mjs`。同步 workflow 與 watchdog 都呼叫這個 module；cron 延遲到隔日 07:30 前仍會檢查最近已關閉的前一日 window。

## Status policy

| Status | 意義 | Job policy |
| --- | --- | --- |
| `published` | 本 window published，且同 window active probe success、版本符合 D1 active | success |
| `unchanged_healthy` | source check 屬於本 window，active probe success，rollback available | success |
| `unchanged_rollback_degraded` | current active 可用，但 previous/state/retain evidence 使 rollback unavailable | fail；summary 明示服務仍可用 |
| `failed_active_healthy` | window failed，但同 window或上週可信 probe仍證明目前 D1 active 可用 | fail；summary 明示服務仍可用 |
| `failed_active_unhealthy` | window failed，且 active probe hard failure | fail |
| `missing` | 07:30 後沒有本 window terminal；有未完成 attempt 時另標 `attempt_incomplete` | fail |
| `record_write_failed` | publisher 或 watchdog 已執行，但 durable evidence 寫入失敗 | fail |
| `unknown` | schema 不支援、版本衝突、query failure 或 probe evidence過期 | fail；不得自動 rollback |

第一階段刻意讓 Yellow 類狀態也使 GitHub job 失敗，因為目前沒有獨立告警管道。所有城市都會先完成評估，再由整批失敗城市清單決定 exit code；不會因第一個城市異常而中止。

## Probe freshness

`published`／`unchanged` 必須使用同 window probe。`failed` 可引用最近一次 success/degraded probe，但同時必須：

- active version 等於目前 `dataset_versions.active_version`。
- probe age 不超過 8 天。
- probe window distance 不超過 1 個週窗。

8 天是保守上限：足以讓本週 window 失敗時引用上週同城市的 A5b probe，又不會在缺乏新訊號時長期沿用 Green。超過任一限制即 `unknown + probe_evidence_expired`。Snapshot generated/imported time不代替 probe freshness。

## Missing investigation

1. 查 `snapshot_window_attempts` 的 expected window。沒有 attempt 表示 workflow 可能沒啟動；有 start、無 terminal 則是 `attempt_incomplete`。
2. 查 `snapshot_window_record_failures`。有 row 表示 terminal/probe atomic batch失敗；不要用上一個 window 的 Green 代替。
3. 查 `snapshot_windows` 與 `snapshot_active_probes` 的 city/window、schema、active version是否一致。
4. 查 `dataset_versions.active_version`。這是線上版本唯一權威。
5. Publisher 沒執行時重跑同 scheduled window；idempotent attempt/canonical upsert不會建立互相矛盾結果。

## Failed but active healthy

`failed_active_healthy` 表示本次同步失敗，但最多 8 天、最多跨一週的 probe仍對應目前 D1 active。先依 window failure class處理 source/publish問題；不要因狀態名稱為 failed 就自動 rollback。若接著 public 使用性也有疑慮，等 A6b public synthetic 或人工 smoke提供第二條證據。

## Rollback degraded reconciliation

`unchanged_rollback_degraded` 不表示 current unavailable。依 publishing runbook 的 authority mismatch repair path：查 D1 active、驗證指定 previous、reconcile R2 state，再執行正常 rollback command。沒有跳過完整性驗證的 `--force`。

## Queries

```powershell
npx wrangler d1 execute mochi-transit --remote --command "SELECT schedule_date, city_code, status, active_version, signal_age_bucket, diagnostic_class FROM snapshot_watchdog_city_results ORDER BY evaluated_at DESC LIMIT 30"
npx wrangler d1 execute mochi-transit --remote --command "SELECT * FROM snapshot_window_attempts WHERE city_code='Taipei' ORDER BY started_at DESC LIMIT 10"
npx wrangler d1 execute mochi-transit --remote --command "SELECT * FROM snapshot_window_record_failures WHERE city_code='Taipei' ORDER BY recorded_at DESC LIMIT 10"
```

Telemetry `window_watchdog_completed` 每城市恰好一筆、100% synthetic sampling。只包含 city/window、固定 enum、版本、age bucket 與 rollback boolean；不保存 workflow URL、route/place identity、artifact key、credential、raw error或 response body。

A6b 才會每日從公網獨立驗證 22 城 routes／network／route／place／journey；A6a 的成功只代表同步 window evidence完整，不宣稱每日 public path健康。
