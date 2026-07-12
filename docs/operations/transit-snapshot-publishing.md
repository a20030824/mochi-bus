# Transit snapshot publishing

快照發布使用 immutable version keys；唯一會改變線上讀取版本的是 D1 `dataset_versions.active_version`。發布工具必須依序完成以下狀態，任何較早階段失敗都不可切換 pointer。

1. Generate：從 TDX 產生 D1 rows、shape、schedule、place bundle 與 network。
2. Local validate：檢查非空、數量暴跌、座標、shape、唯一性與所有引用。
3. Stage：上傳 versioned R2 objects，將新版本 rows 寫入 D1，但仍不可供線上讀取。
4. Remote validate：核對 D1 counts／懸空引用，並讀回 R2 manifest。
5. Activate：用獨立 D1 statement 原子更新 `active_version`。
6. Verify：以 cache-busted 公開 routes API 確認 `snapshotVersion` 與非空 routes。
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

## 8m geometry rollback（2026-07-13）

全路網 `network.json` 與 inline fallback 的 Douglas–Peucker 容差統一為 8m。50m 的 payload 實驗雖然減少 bytes 與座標數，但正式路網以視覺正確性優先；本輪不做城市差異化、多層 LOD、tiles 或 Web Worker。

由 production `dataset_versions.imported_at` 與 50m 變更時間交叉確認，除本輪先重發的 Chiayi 外，仍使用 50m 產物而需重新生成的城市為：

1. Taipei（active `20260712T201010854Z`）
2. NewTaipei（active `20260712T201547917Z`）

安排：Chiayi 驗證完成後，依序手動 dispatch Taipei、NewTaipei；每城均記錄發布前後 `network.json` bytes、座標數、active version，並完成公開 API smoke。其餘城市的 active snapshot 都早於 50m 變更，不列入本次重生清單。

Chiayi 已完成第一站回退與 production 驗證：

| 容差 | Active version | Bytes | 座標數 |
| --- | --- | ---: | ---: |
| 50m（修改前） | `20260712T151455398Z` | 620,381 | 21,739 |
| 8m（修改後） | `20260712T224859683Z` | 1,322,246 | 55,537 |

8m 相較 50m 增加 701,865 bytes（+113.1%）與 33,798 個座標（+155.5%）。Local validation、remote validation、active pointer 切換、公開 routes smoke 均通過；cache-busted production network API 回 200、273 routes，且 version 與 D1 active pointer 一致。
