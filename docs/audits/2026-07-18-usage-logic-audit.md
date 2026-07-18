# Mochi Bus 使用邏輯與互動流程審計 — 2026-07-18

> 本文件記錄 2026-07-18 的唯讀使用邏輯審計，並作為後續修復與回歸測試的執行藍圖。
> 狀態：審計與 Phase 0–4 修復／回歸硬化皆已於本機驗證完成，尚未 commit、push 或部署。

## 1. 紀錄資訊

| 項目 | 內容 |
| --- | --- |
| 專案 | Mochi Bus / mochi-tools |
| 稽核日期 | 2026-07-18（Asia/Taipei） |
| 稽核版本 | main @ 24fc827 |
| 稽核型態 | 唯讀的使用流程、狀態轉移、非同步競態、錯誤恢復與 Playwright 覆蓋審計 |
| 稽核視角 | 從使用者實際操作順序檢查跨入口等價性，不是單檔 code review |
| 本次變更 | 審計輪次只新增本文件；後續修復輪次已依下方執行紀錄修改產品程式與測試，尚未部署 |
| 驗證基線 | npm test 通過：51 個測試檔、307/307 tests |
| 互動驗證限制 | 本輪沒有可用的互動瀏覽器工作階段；確認存在項目由控制流程或資料契約直接證明，競態項目列為可重現風險，未冒充真人點擊重現 |

## 2. 分類規則

- 確認存在：現有控制流程、URL hydration、資料模型或 CSS 條件可以直接證明。
- 可重現風險：需要特定的延遲或回應順序才觸發；程式碼缺少必要的取消或 identity guard。
- 產品決策：是否讓搜尋、行程或手動鏡頭可分享、可跨重整，不在沒有產品規格時判成 bug。

本輪共記錄 8 項：6 項確認存在，2 項可重現 race 風險。

## 3. 主要 user flow

~~~mermaid
flowchart TD
  H["首頁 /<br/>本機 active board + ETA"]
  S["setup /setup"]
  SB["縣市路線列表"]
  SS["方向／站牌"]
  SG["同站建議"]
  B["分享 ETA /bus?..."]
  R["完整站序 /route?..."]
  M["地圖 /map"]
  O["全台總覽"]
  G["區域"]
  C["縣市路線列表"]
  V["支線選擇"]
  RD["路線詳情"]
  T["時刻表"]
  N["附近站牌 lat/lon"]
  P["站牌 arrivals place"]
  F["規劃起點"]
  D["規劃終點"]
  J["直達／轉乘候選"]

  H --> S --> SB --> SS --> SG --> H
  H --> B --> R
  H --> M
  M --> O --> G --> C
  C --> V --> RD --> T
  C --> N --> P --> RD
  C --> F --> D --> J --> RD
  RD --> J
~~~

## 4. 地圖 state transition

~~~mermaid
stateDiagram-v2
  [*] --> Overview
  Overview --> Region
  Region --> Catalogue
  Catalogue --> VariantPicker
  VariantPicker --> RouteDetail
  RouteDetail --> Timetable
  Catalogue --> Nearby
  Nearby --> Place
  Place --> RouteDetail
  Catalogue --> TripFrom
  TripFrom --> TripTo
  TripTo --> TripResults
  TripResults --> RouteDetail
  RouteDetail --> TripResults
~~~

審計基線的地圖不是一般 router，而是單一 history sentinel 加 module state；當時 URL 只完整表示 route、place、lat/lon。Phase 2 已於本機改為可 hydrate 的 history entries，並移除 runtime sentinel，詳見下方執行紀錄。

## 5. 狀態保留與清除原則

| 狀態 | 前進／返回時應保留 | 應清除時機 | 目前行為 |
| --- | --- | --- | --- |
| 縣市 | 同一流程與重整保留 | 明確回全台或改縣市 | 本機已固定 `/map` 為全台；縣市由明確 URL entry 表示 |
| 路線／支線／站牌 | 查看詳情再返回時保留父層脈絡 | 換縣市或回更高父層 | 本機已由 history entry 保存父層，UI back／Browser Back／reload 等價 |
| 路線搜尋／分類／捲動 | detail 返回 catalogue 時保留 | 換縣市 | 本機已保存於 catalogue history state，返回時還原 |
| 行程端點／候選／選中方案／鏡頭 | 檢視路線或站牌再返回時保留 | 取消、新規劃、換縣市 | 本機已保存 trip results 與分享 identity；返回候選時還原鏡頭與選中方案 |
| setup city/filter/category/step | wizard 內前進返回時保留 | 取消，或換縣市後清除下游選擇 | 本機已統一為 history state；Back/Forward/reload 可還原目前分頁的 wizard 狀態 |

### 建議 invariant

1. 眼前畫面、document title、URL 與可重整狀態必須描述同一件事。
2. 畫面返回與 Browser Back 應 dispatch 同一個 transition。
3. 任何離開 loading view 的 transition 都必須使該 view 的未完成請求失效。
4. 即時、stale、schedule、departure-only、headway、rate-limited 與 token rejected 不得共用模糊的成功狀態。
5. 手機與桌面可有不同輸入方式，但不得缺少核心出口、重試或資料可信度說明。

## 6. 風險登錄表

| ID | 分類 | 等級 | 問題 | 主要位置 | 建議階段 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- |
| ULA-001 | 確認存在 | P0 | 地圖 URL、畫面返回、Back/Forward 與 reload 不一致 | web/map/main.ts | Phase 2 | 本機已修復驗證，未部署 |
| ULA-002 | 確認存在 | P1 | setup wizard 的 UI back 與 Browser Back 不等價 | web/setup/main.ts | Phase 3 | 本機已修復驗證，未部署 |
| ULA-003 | 確認存在 | P1 | setup 與地圖收藏同一站牌，首頁 Map 入口不同 | web/setup/main.ts、web/boards/store.ts、web/eta/main.ts | Phase 3 | 本機已修復驗證，未部署 |
| ULA-004 | 確認存在 | P0 | 地圖初始化失敗無 retry；短橫向看不到錯誤 | web/map/main.ts、web/map/style.css | Phase 1 | 本機已修復驗證，未部署 |
| ULA-005 | 可重現風險 | P0 | 返回／取消未使 route、nearby、trip 請求失效 | web/map/main.ts、src/domain/map/nav-request.ts | Phase 0 | 本機已修復驗證，未部署 |
| ULA-006 | 可重現風險 | P0 | 舊路線 vehicle 回應可覆蓋新路線 | web/map/main.ts、web/map/map-api-client.ts | Phase 0 | 本機已修復驗證，未部署 |
| ULA-007 | 確認存在 | P0 | token rejected 與 rate-limit 被降級流程吞掉 | src/routes/map.ts、src/lib/tdx.ts、web/tdx/api-client.ts | Phase 1 | 本機已修復驗證，未部署 |
| ULA-008 | 確認存在 | P0 | Journey 丟失起點發車／班距語意並拿來判斷轉乘 | src/domain/map/journey-estimate.ts、src/domain/map/transfer-estimate.ts | Phase 0 | 本機已修復驗證，未部署 |
| ULA-TEST-001 | 測試風險 | P1 | Playwright 缺跨入口、history、offline、visibility 與真 touch project | playwright.config.ts、test/e2e | Phase 0-4 | 本機已修復驗證，未部署 |

## 7. 詳細問題

### ULA-001 — 地圖 URL、畫面返回、Browser Back/Forward 不是同一套狀態

**分類：確認存在**

**實際操作步驟**

1. 在縣市路線列表輸入搜尋並捲動。
2. 開啟路線詳情，再點 drawer 返回。
3. 觀察父畫面、URL，然後 reload。
4. 另以 Browser Back／Forward 重做。
5. 選過縣市後按 MOCHI MAP 回全台，再 reload /map。

**預期行為**

- 返回後 URL 表示父畫面，搜尋／捲動仍在。
- reload 留在父畫面。
- Browser Back 與畫面返回等價，Forward 可回詳情。
- /map 的語意在同裝置與不同裝置一致。

**目前行為或可證明風險**

- drawVariant() 寫入 route URL，但 renderRoutePicker()／renderVariantPicker() 不校正 URL。
- renderRoutePicker() 重建輸入框與 scroll region，因此搜尋與 scrollTop 清除。
- UI 返回後 reload 會依仍存在的 route/variant query 再次開啟路線。
- Browser Back 經 sentinel pop 後，父畫面的 setViewBack() 又 push 新 sentinel，會截斷 Forward entry。
- initialise() 以 query city 或 getActiveCity() 啟動；showTaiwan() 寫回 /map 卻未清除 active city，reload 又回舊縣市。

**相關檔案與函式**

- web/map/main.ts:351 initialise()
- web/map/main.ts:425 showTaiwan()
- web/map/main.ts:617 renderRoutePicker()
- web/map/main.ts:1050 backActionFor()
- web/map/main.ts:1155 renderVariantPicker()
- web/map/main.ts:1343 drawVariant()
- src/domain/map/view-back.ts:22 createViewBackController()

**使用者影響**

- URL 分享內容與眼前畫面不符。
- 返回後重整會復活已離開內容。
- 列表搜尋位置遺失。
- Forward 無法使用。

**嚴重度與信心**

- 嚴重度：高。
- 信心：高。

**最小修正方向**

- 定義 MapViewState 與單一 transition／serializer。
- catalogue、variant picker、route detail 至少各有唯一 URL 或 history.state。
- UI back 與 popstate 共用 transition；popstate 中不得補 push。
- 明確決定 /map 固定代表全台，或只在明確 resume URL 恢復上次縣市。

**最適合加入的回歸測試**

- 擴充 test/e2e/map-variant-back-layout.spec.ts。
- 同一路徑分別使用 drawer back、page.goBack()、reload、goForward()。
- 同時斷言 URL、heading、search.value、category 與 scrollTop。
- 以 city、route deep link、place、trip 四種入口參數化。

### ULA-002 — setup wizard 的畫面返回與瀏覽器返回不等價

**分類：確認存在**

**實際操作步驟**

1. /setup → 新增站牌。
2. 選路線 → 方向／站牌 → 同站建議。
3. 分別按畫面返回與 Browser Back。

**預期行為**

- 兩者都退回上一個 wizard step。
- 縣市、搜尋、分類及列表脈絡保留。

**目前行為或可證明風險**

- openPicker()、backToRoutes()、backToStops() 只切 hidden 與 module variables。
- setup 沒有 pushState、popstate 或 URL hydrate。
- Browser Back 直接離開 /setup；reload 回到 picker 關閉的初始頁。

**相關檔案與函式**

- web/setup/main.ts:151 openPicker()
- web/setup/main.ts:163 hidePicker()
- web/setup/main.ts:173 backToRoutes()
- web/setup/main.ts:182 backToStops()
- src/ui.ts:69 renderSetupPage()

**使用者影響**

- 手機系統返回手勢可能一次丟掉多步選擇。

**嚴重度與信心**

- 嚴重度：中高。
- 信心：高。

**最小修正方向**

- 將 wizard step 寫入 history.state。
- 進入 direction／suggestion 時 push，popstate 呼叫既有 back transition。
- 是否把 step 放入分享 URL 可另作產品決策。

**最適合加入的回歸測試**

- 擴充 test/e2e/setup.spec.ts golden path。
- suggestion 後連續 goBack()，應依序回 direction、route picker。
- 仍停在 /setup，city/filter/category 保留。

### ULA-003 — 同一站牌從 setup 與地圖收藏，首頁 Map 入口結果不同

**分類：確認存在的不一致**

**實際操作步驟**

1. 從 setup 儲存某站牌，回首頁點地圖。
2. 從地圖站牌頁收藏同方向，回首頁點地圖。

**預期行為**

- 兩個入口都回到相同站牌 arrivals。

**目前行為或可證明風險**

- setup 建立的 board 沒有 board-level placeId；首頁只能組 /map?city=...。
- 地圖收藏保存 city/placeId/lat/lon；首頁能組 /map?city=...&place=...，直達站牌。

**相關檔案與函式**

- web/setup/main.ts:390 renderSuggestions()
- web/boards/store.ts:94 toggleFavoriteDirection()
- web/eta/main.ts:330 mapLink 組合

**使用者影響**

- 使用者做的是同一件事，但一種收藏能回站牌，另一種只能回縣市路線列表。

**嚴重度與信心**

- 嚴重度：中。
- 信心：高。

**最小修正方向**

- setup 的站牌 API 回傳或解析 placeId，儲存相同的 board place identity。
- 或首頁在缺 placeId 時依 stopUid 解析站牌。

**最適合加入的回歸測試**

- setup 完整走到加入常用站牌 → 首頁 → 地圖。
- 再用地圖收藏建立同站資料。
- 斷言兩者 Map href 與最終 place heading 相同。

### ULA-004 — 地圖初始化失敗沒有重試；短橫向手機看不到錯誤

**分類：確認存在**

**實際操作步驟**

1. 以 636×381 或 420×312 開啟 /map。
2. 讓 /api/v1/map/cities 首次失敗或離線。

**預期行為**

- 顯示可見錯誤、返回入口與再試一次。
- 網路恢復後可原地重試。

**目前行為或可證明風險**

- initialise() catch 只呼叫 setStatus()，初始 drawer 仍為空，沒有 retry。
- 短橫向 media query 將 .map-status 裁為 1×1 並 clip。
- 首頁連結仍可用，但若要恢復地圖只能 reload。

**相關檔案與函式**

- web/map/main.ts:351 initialise()
- src/map-page.ts:53 初始 drawer
- web/map/style.css:765 短橫向 .map-status

**使用者影響**

- 首次離線或短暫 5xx 時，使用者看不出原因，也無法原地恢復。

**嚴重度與信心**

- 嚴重度：中高。
- 信心：高。

**最小修正方向**

- 初始化錯誤在 drawer render 明確 error + retry。
- .map-status.error 不套用短橫向 visually-hidden 規則。

**最適合加入的回歸測試**

- 在 test/e2e/map-mobile-entry-spacing.spec.ts 讓 cities 第一次失敗、第二次成功。
- 斷言錯誤可見，點 retry 後進入全台選擇。

### ULA-005 — 返回／取消沒有使正在進行的導航請求失效

**分類：可重現 race 風險**

**實際操作步驟**

1. 延遲 route variants 回應，點路線後立刻點返回路線。
2. 或規劃行程、點地圖選起點，延遲 nearby 回應後立刻取消規劃。

**預期行為**

- 離開 loading view 後，舊回應不得再改畫面。

**目前行為或可證明風險**

- loadRoute() 使用 nav request ID，但 renderRoutePicker() 不會 begin/cancel 新 epoch。
- 舊 route 回應仍被視為 current，完成後會重新開啟剛取消的路線。
- selectTripCoordinate() 沒有 signal/request ID；取消後回應仍會設定起點並重新進入目的地步驟。

**相關檔案與函式**

- web/map/main.ts:617 renderRoutePicker()
- web/map/main.ts:961 cancelTripMode()
- web/map/main.ts:1100 loadRoute()
- web/map/main.ts:1585 selectTripCoordinate()
- src/domain/map/nav-request.ts:7 createNavRequestCoordinator()

**使用者影響**

- 已取消的路線或規劃突然回來。
- 若期間換縣市，可能把舊縣市站牌寫進新狀態。

**嚴重度與信心**

- 嚴重度：高。
- 信心：高。

**最小修正方向**

- coordinator 增加 cancel()。
- 所有 parent/cancel/city transition 都使舊 epoch 失效。
- trip nearby 傳 signal，await 後核對 city、stage、epoch。

**最適合加入的回歸測試**

- Playwright 控制延遲 route/nearby。
- 返回或取消後再完成舊回應。
- 斷言仍停在 route picker，且沒有 selected endpoint。

### ULA-006 — 舊路線的車輛定位可覆蓋新路線／新支線

**分類：可重現 race 風險**

**實際操作步驟**

1. 延遲路線 A 的 vehicles。
2. 切到 B，先完成 B，再完成 A。

**預期行為**

- 畫面是 B 時只能接受 B 的車輛結果。

**目前行為或可證明風險**

- startVehicleRefresh() 只在 await 前檢查 activeCity/interactionMode。
- 回應後直接清空並重畫 vehicle layer。
- stopVehicleRefresh() 只清 interval 和現有 markers，無法取消 in-flight request。
- mapApi.vehicles() 不接受 signal。

**相關檔案與函式**

- web/map/main.ts:1440 startVehicleRefresh()
- web/map/main.ts:1468 stopVehicleRefresh()
- web/map/map-api-client.ts:242 vehicles()

**使用者影響**

- 路線、站序、URL 都是 B，地圖卻可能顯示 A 的即時車輛位置。

**嚴重度與信心**

- 嚴重度：高。
- 信心：高。

**最小修正方向**

- 車輛輪詢使用獨立 epoch + AbortController。
- await 後核對 epoch、city、variantKey/routeUid。

**最適合加入的回歸測試**

- 延遲 A、先完成 B、再完成 A。
- 最終只允許 B 的 plate／座標 marker。

### ULA-007 — token rejected 與 rate-limit 被降級流程吞掉

**分類：確認存在的契約問題**

**實際操作步驟**

1. 使用自備憑證，讓快取 token 被 TDX 以 401 拒絕，再開首頁收藏站牌或 map place。
2. 另一分支讓 arrivals 即時查詢回 429，但伺服器有 schedule/stale fallback。

**預期行為**

- 401 淘汰 token、換新並重試一次；仍失敗時引導 /setup。
- 429 保留降級資料，但清楚顯示即時查詢受限及 retry。

**目前行為或可證明風險**

- 瀏覽器只有收到 coded 401 才更新 token。
- /api/v1/eta 與 place-arrivals 內層先 catch TDX 錯誤，coded-401 分支到不了。
- Arrivals 雖回 realtime.rateLimited，地圖及首頁 client 只取 routes，丟棄 metadata。
- 地圖成功後會 clearStatus()。

**相關檔案與函式**

- web/tdx/api-client.ts:14 requestMochiJson()
- src/routes/map.ts:423 place arrivals catch
- src/lib/tdx.ts:534 getCommuteETA()
- web/map/map-api-client.ts:308 placeRoutes()
- web/eta/main.ts:239 首頁 place refresh

**使用者影響**

- 失效 token 留在快取，使用者只看到 schedule、暫無資訊或無法更新。
- rate-limit 時不知道即時資料已不可用。

**嚴重度與信心**

- 嚴重度：高。
- 信心：高。

**最小修正方向**

- 內層遇到 user-token 401 必須 rethrow，讓 coded-401／單次 refresh 生效。
- 定義完整 PlaceArrivalsResponse，保留 warning/rateLimited。
- 地圖與首頁共用降級提示及 setup/retry action。

**最適合加入的回歸測試**

1. Worker 測 coded 401。
2. browser client 測只刷新一次並重送。
3. E2E 讓 arrivals 回 rateLimited:true 加 schedule rows，驗證資料仍顯示且警示、retry、setup 入口存在。

### ULA-008 — Journey 丟失起點發車／班距語意，卻拿來判斷轉乘

**分類：確認存在的資料模型問題**

**實際操作步驟**

1. 規劃缺少即時 ETA 的行程。
2. 候選只有起點發車時刻，使用者在下游站上車；或路線採班距制。

**預期行為**

- 顯示起點 HH:mm 發車或 N–M 分一班。
- 不可宣稱為本站到站時間。
- 不應用固定 ±2 分誤差判斷轉乘銜接。

**目前行為或可證明風險**

- nextScheduledMinutes() 原本有 departureBased/headwayMinutes。
- JourneyEstimate 只保留 minutes/source。
- formatJourneyWait() 將超過 60 分一律轉成 HH:mm 到站。
- 轉乘把該 minutes 當精確本站 ETA，判斷 likely/tight/missed。
- 成功摘要固定寫依即時到站，即使來源是 schedule。

**相關檔案與函式**

- src/domain/schedule.ts:39 nextScheduledMinutes()
- src/domain/map/journey-estimate.ts:44 scheduledJourneyEstimates()
- src/domain/eta-presentation.ts:77 formatJourneyWait()
- src/domain/map/transfer-estimate.ts:29 estimateTransfer()
- web/map/main.ts:1690 行程排序

**使用者影響**

- 候選排序、總時間與是否接得上可能建立在起點發車下限，造成錯誤推薦與過度信心。

**嚴重度與信心**

- 嚴重度：高。
- 信心：高。

**最小修正方向**

- JourneyEstimate 保留 departureBased、headwayMinutes、必要時 nextDay。
- departure-only 不進入精確本站 ETA 或轉乘判定。
- 班距以範圍估算，不是最大值單點。

**最適合加入的回歸測試**

- 建立下游站無 StopTime、只有起點時刻及 active headway 的 domain fixture。
- 斷言不輸出到站，轉乘狀態維持 unknown。
- 加 journey E2E 驗證起點發車／N–M 分一班。

## 8. loading／empty／error／資料可信度結論

| 狀態 | 目前結論 |
| --- | --- |
| loading | city、route、place、timetable 等主要流程多有 loading 文案或 skeleton |
| empty | nearby、direct、transfer、timetable 多有明確 empty 文案與父層出口 |
| error | 多數 map request 有 retry；初始化失敗亦已於本機補上可見 error drawer 與原地 retry，尚未部署 |
| stale | ETA 以稍早標示，方向正確 |
| estimated | 一般 ETA 以約標示；Journey 起點發車／班距語意已於本機修復，尚未部署 |
| offline | 初始化離線失敗已於本機支援 online 後原地 retry；進入應用後多數 request 可手動 retry；尚未部署 |
| rate-limited | 本機已保留 stale/schedule rows 並顯示警示、retry、setup；尚未部署 |
| token rejected | 本機已恢復 coded-401、單次換 token／重送及 setup recovery；尚未部署 |
| 今日無班次／班距 | timetable 與 Journey 卡片皆已能區分；Journey 修復尚未部署 |

## 9. 手機與桌面

未發現沒有理由的核心功能刪減。手機與桌面共用主要 renderer；以下差異有明確輸入裝置理由，不列為問題：

- 手機隱藏 Leaflet zoom，保留手勢縮放。
- 無 hover 裝置不綁 tooltip。
- touch 路線使用更大的透明 hit target。
- network pick tolerance 在 touch 放大。

短橫向初始化錯誤已於本機改由 drawer 顯示並提供 retry，見 ULA-004 執行紀錄。Phase 4 已新增真 `hasTouch/isMobile` project，並實際驗證 `hoverCapable=false` 的 26px 透明路線命中層、全路網 coarse picker 與短橫向 retry。

## 10. Playwright 覆蓋判定

審計基線的 17 個 spec、48 個 test() 宣告中：

- 只有 2 次 reload，皆在 feature-discovery。
- 已補 map bootstrap network failure → retry recovery；仍沒有 goBack()、goForward()、pageshow/pagehide、visibilitychange 或真 touch project 測試。
- playwright.config.ts 沒有 devices、hasTouch、isMobile projects。
- 所謂手機測試只改 viewport，沒有覆蓋 hoverCapable=false 的 touch 分支。
- ETA 測試直接注入 localStorage。
- setup golden path 在儲存前停止。
- 沒有 setup → home → map/place 或 share URL → route → back 的跨入口等價測試。
- CI 只跑 Chromium，且不是全部 e2e specs。

截至 Phase 4 本機修復完成，Playwright 共 24 個 spec／72 tests，分為 `desktop-chromium`、`mobile-touch` 與 `visual-chromium` 三個 project：

- desktop＋touch 互動矩陣 66/66 通過，涵蓋 Back／Forward／reload、跨入口收藏、延遲回應、duplicate activation、offline recovery、visibility hidden→visible resume 與真 touch 操作。
- visual project 6/6 通過，沿用既有平台快照，不因 project 拆分重建基準。
- CI 不再手動列舉部分 spec；會執行完整 `desktop-chromium`＋`mobile-touch` 非視覺矩陣，再允許 production deploy。
- `visibilitychange` 測試以可控的 `document.hidden`／`visibilityState` 驗證瀏覽器生命週期契約；避免把 headless Chromium 不會自動隱藏背景 page 的行為誤當成產品結果。

### 建議共用 flow matrix

| 入口 | 必測操作 |
| --- | --- |
| 首頁 local board | setup 建立、map 建立、reload、visibility resume |
| /setup | UI back、Browser Back/Forward、reload、快速換縣市、關閉 picker |
| /map city catalogue | 搜尋、scroll、route detail、UI back、Browser Back/Forward |
| route deep link | reload、variant、timetable、back |
| nearby/place | lat/lon、place URL、route branch、back、offline recovery |
| trip | double click、cancel while loading、direct/transfer branch、camera restore |
| shared /bus、/route | 新分頁直達、站內返回、map entry |
| mobile touch | route line hit、network pick、短橫向 error/retry |

## 11. 修復行程安排

### 排程原則

1. 先修會顯示錯誤交通資訊或讓舊回應覆蓋新狀態的 correctness 問題。
2. 再修錯誤恢復與資料可信度契約。
3. 導航 URL/state 改動範圍較大，需在 async safety 穩定後進行。
4. setup 與收藏等價性最後接上共用 navigation／identity 契約。
5. 每個修復 PR 必須先加入能失敗的回歸測試；不得只補單元測試而略過操作順序。

### 建議依賴圖

~~~mermaid
flowchart LR
  A["Phase 0<br/>Async + Journey correctness"]
  B["Phase 1<br/>Error/degraded contracts"]
  C["Phase 2<br/>Map navigation state"]
  D["Phase 3<br/>Setup + entry equivalence"]
  E["Phase 4<br/>Cross-entry/touch hardening"]

  A --> B --> C --> D --> E
~~~

### Phase 0 — 正確性止血

**建議拆成 2 個 PR，約 1–2 個工作日。**

#### PR 0A：Async invalidation

- 處理 ULA-005、ULA-006。
- nav coordinator 增加 cancel。
- route/nearby/trip parent transition 使舊 request 失效。
- vehicle polling 增加獨立 epoch、AbortController 與 variant identity check。
- 先加入延遲 A／快速 B／最後完成 A 的 deterministic tests。

**2026-07-18 執行紀錄**

- `src/domain/map/nav-request.ts` 已加入明確的 `cancel()`；返回區域、路線目錄、附近站牌及行程候選等 parent transition 會使舊 navigation request 失效。
- `selectTripCoordinate()` 已傳遞 `AbortSignal`，並在落地前核對 request、city 與 trip stage。
- vehicle polling 已使用獨立 epoch 與 `AbortController`；停止或切換路線後，舊回應不能再清空／重畫目前 vehicle layer。
- 新增 `test/e2e/map-async-navigation.spec.ts`，deterministic 覆蓋 route 返回、trip 取消與 A→B vehicle late response 三條操作序列。
- 本機驗證：`npm test` 51 files／309 tests 通過；`npm run typecheck` 通過；`npm run build:map` 通過；相關 Playwright 8 tests（3 條新競態測試＋5 條既有 route/trip 測試）通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- 返回、取消、換縣市後，舊 route/nearby 回應不再改 DOM、URL 或 module state。
- vehicle 最終 marker 必定屬於目前 routeUid/variantKey。
- 重複點擊不會建立兩個並行狀態。

#### PR 0B：Journey schedule semantics

- 處理 ULA-008。
- JourneyEstimate 傳遞 departureBased/headwayMinutes/nextDay。
- departure-only 不作為本站精確 ETA。
- headway 以範圍參與估算。
- 修正直達／轉乘卡文案與 estimate note。

**2026-07-18 執行紀錄**

- Journey estimate API 已保留 `departureBased`、`headwayMinutes` 與 `nextDay`，不再把隔日班次直接降成 `none`。
- 起點發車顯示為「約 N 分後發車」或 `HH:mm 發車`；班距制顯示 `N–M 分一班`；隔日班次明確加「明日」。
- 起點發車、班距、隔日資料不再作為直達路線的精確本站 ETA 排序鍵。
- 轉乘的 `likely`／`tight`／`missed` 只接受可靠即時本站到站；schedule、stale、departure-only、headway 與 next-day 都維持 `unknown`，卡片顯示車程＋步行範圍並註明未含候車。
- 新增 `test/e2e/map-journey-semantics.spec.ts`，實際覆蓋班距卡片與 schedule-only 轉乘不產生假銜接結論。
- 本機驗證：`npm test` 51 files／314 tests 通過；`npm run typecheck` 通過；`npm run build:map` 通過；相關 Playwright 5 tests（2 條新 Journey 語意測試＋3 條既有 direct/transfer 測試）通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- 起點發車資料永不顯示成本站到站。
- 班距資料顯示 N–M 分一班。
- 資料不足時 connectionStatus 為 unknown，不產生 likely/tight/missed 假精度。

### Phase 1 — 錯誤恢復與降級契約

**建議拆成 2 個 PR，約 1–2 個工作日。**

#### PR 1A：TDX rejected/rate-limit contract

- 處理 ULA-007。
- user-token 401 穿透到 coded-401。
- client 僅更新 token 一次並重送原請求。
- PlaceArrivalsResponse 保留 warning/realtime metadata。
- map 與 home 共用 degraded banner、retry、setup action。

**2026-07-18 執行紀錄**

- `/api/v1/eta`、place arrivals、vehicles 與 journey ETA 的內層降級 catch，遇到目前 user token 的 401 時會重新拋出；外層統一回傳 `TDX_ACCESS_TOKEN_REJECTED` coded 401。
- browser client 以具 `status`／`code` 的 `MochiApiError` 保留錯誤契約；既有 refresh-once 流程仍只換 token 並重送原請求一次，第二次拒絕會交回 UI，不形成單次請求內的 refresh loop。
- Place arrivals 現在保留 `warning` 與 `realtime` metadata；rate-limit、quota 與 unavailable 會保留最強警示，authenticated 或 degraded response 使用 `no-store`。
- map 站牌 drawer 與首頁 ETA 會在保留 stale/schedule 資料時明確顯示即時資料受限，並提供 retry 與 `/setup`；token rejected 也提供相同復原出口，不再靜默降級。
- 新增 `src/tdx-api-contract.test.ts`、map client contract test、`test/e2e/map-degraded-data.spec.ts` 與首頁 degraded/rejected Playwright 情境。
- 本機驗證：`npm test` 52 files／316 tests 通過；`npm run typecheck` 通過；`npm run build:map` 通過；相關 Playwright 10 tests 通過；`git diff --check` 通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- token rejected 不會靜默留在快取。
- rate-limited 仍可顯示 stale/schedule，但明確說明不是即時資料。
- repeated retry 不形成 refresh loop。

#### PR 1B：Map bootstrap recovery

- 處理 ULA-004。
- 初始化錯誤 render drawer error view。
- retry 重跑 cities hydration。
- 短橫向 error 保持可見。
- 加 offline → online → retry 測試。

**2026-07-18 執行紀錄**

- `initialise()` 已加入單一執行鎖，連續點擊 retry 不會建立並行 bootstrap。
- cities hydration 失敗時不再只寫入可能被短橫向 CSS 隱藏的 status，而會 render 明確的 error drawer、原因說明與「再試一次」。
- retry 會在原頁重新執行完整 bootstrap；測試以首次 cities request 503、第二次成功模擬 network unavailable → available，驗證不需 reload 即回到區域選擇。
- 新增 `test/e2e/map-bootstrap-recovery.spec.ts`，使用 636×381 短橫向 viewport 驗證錯誤標題與 retry 均可見、可操作，且 URL 維持 `/map`。
- Phase 0B 對 schedule-only 轉乘文案的刻意修正亦已同步更新既有 `map-trip-results` 視覺基準；核對後內容為「車程＋步行」與「未含候車與路況」，不是本階段版面回歸。
- 本機驗證：`npm test` 52 files／316 tests 通過；`npm run typecheck` 通過；`npm run build:map` 通過；bootstrap、短橫向與 map visual Playwright 6 tests 通過；`git diff --check` 通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- 所有 viewport 都能看見錯誤與 retry。
- 首次失敗後不需 reload 即可恢復。

### Phase 2 — 地圖 navigation state 單一化

**建議 1 個獨立 PR，約 2–3 個工作日。**

- 處理 ULA-001。
- 先定義 MapViewState、transition、serialize/hydrate，不先大改視覺 renderer。
- 明確定義 overview、region、catalogue、variant picker、route、place、nearby、trip branch 的父子關係。
- 決定 /map 的固定語意。
- search/category/scroll 放 history.state；跨 reload 是否保存可維持產品決策。
- popstate 只 hydrate/transition，不補 push。

**2026-07-18 執行紀錄**

- route catalogue 已將 search、category 與 scrollTop 保存於目前 history entry；從 route detail 使用 drawer back 返回時會還原三者。
- `renderRoutePicker()` 會把 URL 校正為 `/map?city=…`；返回後 reload 不再因殘留 route/variant query 復活已離開的 route detail。
- variant picker 與 route detail 更新 URL 時會保留 catalogue history state，不再以 `null` 覆蓋。
- `/map` 已固定代表全台總覽，不再因 localStorage 的上一個縣市而在 reload 後改變語意；region 使用 `/map?region=…`，catalogue 使用 `/map?city=…`。
- overview、region、catalogue、route、nearby 與 place 已建立可 hydrate 的 history entries；drawer back 與 Browser Back／Forward 會落到同一 URL 與 renderer。
- trip results 已使用 `/map?city=…&trip=results`，並把起終點、候選資料與選取索引保存至 history.state；從候選路線詳情返回不再殘留 route/variant URL，且同分頁 Back／Forward／reload 可還原候選。
- trip 分享 URL 另帶 `from`／`to` place identity；即使沒有 history.state，也會重新取得兩端站牌並重建直達／轉乘候選。
- 首次開啟 region、route、nearby、place 或 trip 深連結時會合成 overview → region → catalogue → target 的父層 history；UI back 與 Browser Back 因此共用同一 transition。
- direct place 的返回文案依實際父層顯示「返回路線列表」，從 nearby 點入則維持「附近站牌」，避免按鈕宣稱的去向與 history 不同。
- 已移除 runtime sentinel controller 與把「popstate 後補 push」視為正確行為的舊單元測試；Forward 不再被新 push 截斷。
- 新增 `test/e2e/map-navigation-equivalence.spec.ts`，覆蓋 catalogue 搜尋／捲動 → route、overview → region → catalogue、nearby → place 的 drawer back／Browser Back／Forward／reload 等價性。
- 新增／擴充 `test/e2e/map-navigation-equivalence.spec.ts` 與 `test/e2e/map-direct.spec.ts`，覆蓋 UI back、Browser Back／Forward、reload、深連結父層、無 history.state 的 trip 分享還原，以及 search/category/scroll preservation。
- 最終本機驗證：`npm test` 51 files／311 tests 通過；`npm run typecheck` 與 `npm run build:map` 通過；完整 Playwright 66 tests 通過；`git diff --check` 通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- UI back 與 Browser Back 的畫面、URL、title 相同。
- Forward 可回子畫面。
- reload 不會開啟已離開的 route detail。
- route detail 返回 catalogue 時 search/category/scroll 保留。
- 從 trip branch 返回不留下 route detail URL。

### Phase 3 — setup 與跨入口等價

**建議拆成 2 個小 PR，約 1–2 個工作日。**

#### PR 3A：Setup history

- 處理 ULA-002。
- wizard step 使用 history.state。
- Browser Back/Forward 與 UI back 共用 transition。
- city change 清 route/stop/suggestion；回到 route picker 保留 filter/category/scroll。

**2026-07-18 執行紀錄**

- setup 的 `closed`、`routes`、`stops`、`suggestions` 已成為明確 history entries；UI back、Browser Back／Forward 與 popstate 共用同一組 hydration 邏輯。
- route entry 保存 city、filter、category、scrollTop 與 route catalog；返回 route picker 時不再清空使用者的篩選與列表位置。
- stops 與 suggestions entry 保存已選路線、方向／站牌群組與建議 snapshot；同分頁 reload 可還原，不需重送請求才能看到原步驟。
- 換縣市會清除 route／stop／suggestion 下游狀態並啟動新 request epoch；關閉 picker、連續返回或舊回應晚到都不會重新打開已離開步驟。
- 初始 `/setup` 不搶焦點；只有 Escape、關閉或 popstate 回到 closed 時，才將焦點還給「新增常用站牌」。既有 setup 視覺快照維持不變。
- `test/e2e/setup.spec.ts` golden path 已覆蓋 routes → stops → suggestions 的 Browser Back／Forward、UI back、reload 與 filter preservation。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

#### PR 3B：Favorite place identity

- 處理 ULA-003。
- setup 儲存 placeId 或在首頁解析 stopUid → place。
- map/setup 建立的相同站牌使用同一 map deep link。

**2026-07-18 執行紀錄**

- snapshot repository 新增參數化 D1 查詢，以 active snapshot 的 `city + stopUid` 解析穩定 `placeId`、站名與座標；`/api/v1/stop-routes` 將 place identity 與同站建議一併回傳。
- setup suggestion snapshot 保留 place identity；使用者儲存看板時一併寫入 board-level `city`、`placeId`、`latitude`、`longitude`，首頁因此能產生 `/map?city=…&place=…` 直達站牌連結。
- 新增 repository 單元測試，鎖定 prepared statement join 與 bind 參數；Playwright 以同一站實際走完「setup 收藏 → 首頁 → 地圖」及「地圖收藏 → 首頁 → 地圖」，斷言 href、最終 URL 與站牌 heading 完全相同。
- Phase 3 最終本機驗證：`npm test` 51 files／312 tests 通過；`npm run typecheck` 與 `npm run build:map` 通過；完整 Playwright 67/67 通過；`git diff --check` 通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- setup 系統返回手勢不離開 wizard。
- setup 建立與 map 建立的同站收藏，首頁 Map 入口等價。

### Phase 4 — 回歸矩陣與裝置硬化

**建議 1 個測試 PR，約 1–2 個工作日。**

- 處理 ULA-TEST-001。
- Playwright 新增 desktop Chromium 與至少一個真 touch mobile project。
- 加入跨入口 flow fixture。
- 覆蓋 Back/Forward/reload、duplicate click、delayed response、offline recovery、visibility resume。
- CI 執行全部非視覺 e2e；視覺 snapshots 可維持獨立 job。

**2026-07-18 執行紀錄**

- `playwright.config.ts` 已建立 `desktop-chromium`、Pixel 7 `mobile-touch` 與 `visual-chromium`；快照 path template 刻意不含 project name，因此既有 Win32／Linux 基準仍可沿用。
- 新增 `test/e2e/mobile-touch.spec.ts`：runtime 斷言 `maxTouchPoints > 0`、`hover: hover = false`、`pointer: coarse = true`，並實際 tap 26px 透明路線 hit target、全路網 coarse picker 與 636×381 初始化 retry。
- 新增 `test/e2e/eta-lifecycle.spec.ts`：hidden 狀態不刷新、visible resume 只刷新一次，刷新未完成時的連續 visibility events 由既有 disabled guard 合併，完成後仍可手動 retry。
- setup 回歸新增 route `dblclick`，確認只建立一個 stops history entry；一次 Back 回 routes、再一次 Back 回 closed，不會產生重複步驟。
- `.github/workflows/ci.yml` 已由手動列舉 13 個 spec 改為執行完整 desktop＋touch projects；視覺 project 維持獨立本機／專用 job 能力，不讓平台限定 PNG 阻擋 Linux 互動矩陣。
- Phase 4 沒有暴露新的產品程式缺陷，因此本階段只修改 Playwright／CI 設定與回歸測試，未為了讓測試通過而改產品互動。
- 最終本機驗證：`npm test` 51 files／312 tests、`npm run typecheck`、`npm run build:map` 皆通過；desktop＋touch 66/66、visual 6/6，合計 Playwright 72/72；`git diff --check` 通過。
- 狀態僅代表工作樹本機驗證完成；尚未 commit、push 或部署。

**驗收條件**

- touch project 實際滿足 hasTouch/isMobile，hoverCapable=false。
- 所有 8 項問題都有至少一條回歸測試。
- CI 不只驗單一 happy path。

### 建議工作日行程

| 工作日 | 主要內容 | 交付 |
| --- | --- | --- |
| Day 1 | ULA-005、ULA-006 | Async/vehicle race tests + fix |
| Day 2 | ULA-008 | Journey semantics contract + UI |
| Day 3 | ULA-007 | 401/rate-limit API/client/UI contract |
| Day 4 | ULA-004；準備 navigation fixtures | Bootstrap retry + history test harness |
| Day 5–6 | ULA-001 | MapViewState、Back/Forward、URL hydration |
| Day 7 | ULA-002、ULA-003 | Setup history + favorite place identity |
| Day 8 | ULA-TEST-001 | Touch/offline/visibility/cross-entry CI matrix |

這是依目前程式範圍的工作量估計，不是承諾日期。若拆分時發現 MapViewState 需要改動更多 route/trip renderer，Phase 2 應獨立延長，不應與其他 correctness 修復混在同一 PR。

## 12. Definition of Done

每一階段完成時至少滿足：

1. 對應風險 ID 的失敗測試先存在，修復後轉綠。
2. npm test、typecheck、build 與相關 Playwright flows 通過。
3. URL、document title、drawer heading、map layer identity 同步。
4. 所有 async response 在落地前核對 request identity。
5. degraded data 同時帶來源與可操作的下一步。
6. desktop 與真 touch mobile 都覆蓋核心流程。
7. 更新本文件風險表狀態與實際 PR／commit／部署證據。

## 13. 不列為本輪 bug 的產品決策

- 行程規劃是否能以 URL 分享。
- route 搜尋、分類、捲動是否要跨完整 reload 保存。
- 使用者手動平移／縮放的地圖鏡頭是否要寫入 URL。
- 手機隱藏 zoom controls、取消 hover tooltip、放大 hit target。

上述決策不影響本輪要求的核心 invariant：同一操作的返回結果一致、URL 不說謊、舊回應不能覆蓋新狀態、資料可信度必須清楚。
