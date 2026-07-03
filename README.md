# Mochi Bus

固定通勤用的極簡公車工具。封面只呈現常用站牌與即時 ETA；路線挑選、同站多車及完整站序都收在第二層。

## 本機啟動

建立 `.dev.vars`：

```dotenv
TDX_CLIENT_ID="你的 Client ID"
TDX_CLIENT_SECRET="你的 Client Secret"
```

```sh
npm install
npm run dev
```

## 使用方式

- `/`：封面，顯示目前選定的「常用站牌」及多班公車 ETA
- `/setup`：從路線分類與篩選建立、刪除及切換常用站牌
- `/route?...`：完整站序與各站 ETA
- `/map`：圖形化選縣市與路線，在真實地圖上查看 Shape 與所有站牌
- `/bus?...`：可分享的單班公車查詢
- `/shortcut?...`：iPhone 捷徑純文字輸出

設定流程不要求輸入完整路線或自訂名稱：先選縣市，再從分類／即時篩選選路線、方向與站牌。站牌名稱會成為常用站牌名稱，並可勾選同一實體站牌附近的其他公車一起顯示。

## API

- `/api/v1/routes?city=Taipei`：縣市路線目錄
- `/api/v1/stops?city=Taipei&route=307`：路線方向與完整站序
- `/api/v1/stop-routes?city=Taipei&stop=捷運西門站&stopUid=TPE213044`：同一實體站牌附近的公車
- `/api/v1/eta?...`：單班 ETA
- `/api/v1/map/cities`：地圖縣市中心點與區域
- `/api/v1/map/route?city=Taipei&route=307`：GeoJSON 路線線型與站牌

## 公車地圖

地圖前端位於 `web/map/`，使用 Vite、Leaflet 與 OpenStreetMap。TDX `EncodedPolyline` 由 Worker 解碼並正規化成 GeoJSON，前端不直接依賴 TDX 欄位。

```sh
npm run build:map
```

目前地圖支援區域／縣市選擇、路線分類、方向與支線選擇、Polyline、站牌及可分享 URL。即時車輛與常用站牌整合保留給下一階段。

名稱查詢若只有一個符合站牌，會轉址至包含 `StopUID` 的 canonical URL；不同支線存在同名站牌時會先要求選擇。

## 本機資料

常用站牌保存在瀏覽器 localStorage：

```text
mochi.bus.boards.v2
mochi.bus.activeBoard.v2
```

舊的 `mochi.bus.presets.v1` 會在第一次開啟時自動轉換。每張常用站牌可以包含多班公車；只保存路線、方向與 UID，不保存 ETA。

## 驗證與部署

```sh
npm run check
npx wrangler secret put TDX_CLIENT_ID
npx wrangler secret put TDX_CLIENT_SECRET
npm run deploy
```
