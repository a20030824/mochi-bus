# Legacy previous snapshot repair

當 current active snapshot 的 11 項 hard checks 全部通過，但 previous snapshot 因舊版 manifest contract 而得到 `previous_unavailable` 時，不得放寬 rollback probe。應透過既有 **Sync transit snapshots** workflow 的 guarded repair mode，重新發布一個通過現行 gate 的 snapshot，讓原本健康的 active 成為新的 previous。

此模式只處理下列精確狀態：

- latest active probe=`degraded`
- failure class=`previous_unavailable`
- hard checks=`11/11`
- diagnostic warnings 只有 `previous_unavailable`
- D1 active、probe active 與輸入的 expected active 完全一致
- probe previous 與輸入的 expected previous 完全一致

## GitHub Actions inputs

在 **Sync transit snapshots** 選擇 **Run workflow**，一次只處理一個城市：

| Input | Required value |
| --- | --- |
| `city` | 單一 TDX city code |
| `force_publish` | `true` |
| `window_type` | `manual` |
| `window_date` | 明確的 Asia/Taipei 日期，格式 `YYYY-MM-DD` |
| `repair_legacy_previous` | `true` |
| `expected_active` | 執行前實際 D1 active version |
| `expected_previous` | latest probe 記錄的 legacy previous version |

Expected versions 同時是 optimistic concurrency guard。任一 version、probe 狀態或 warning 已改變，preflight 會在 publisher 啟動前 fail closed。

## Postflight contract

成功不只代表 publisher exit 0。Repair mode 還要求 durable window／probe evidence 同時符合：

- manual window result=`published`
- `force_publish=1`
- window、probe 與 D1 指向同一個新 active
- window previous 與 probe previous 都等於執行前的 expected active
- active probe=`success`
- hard checks=`11/11`
- warnings 為空
- `rollback_available=1`

任一 postflight 條件不符，workflow 必須失敗。不要以手動 D1 pointer update、放寬 manifest schema 或略過 public smoke 取代此流程。

## Batch policy

Repair dispatch 仍使用 `transit-snapshot` concurrency group，但每日 D1 寫入額度需由操作者控制。先執行小城市或小批次，逐城確認 durable postflight，再進入下一批；不要把多個城市塞入同一次 repair dispatch。

一般發布、排程 window、watchdog 與 rollback contract 仍以 [Transit snapshot publishing](./transit-snapshot-publishing.md) 為準。
