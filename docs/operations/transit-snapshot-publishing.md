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

## Rollback

預設切回 state 中記錄的 previous version：

```powershell
npm run snapshot:rollback -- Chiayi
```

指定仍保留於 D1/R2 的版本：

```powershell
npm run snapshot:rollback -- Chiayi 20260711T000000000Z
```

Rollback 會先確認目標 D1 rows 與 R2 manifest/network 存在，切換後再跑公開 smoke；若 smoke 失敗，會自動恢復原版本。成功後 state 的 active/previous 會互換，因此可以再次執行以復原 rollback。

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
