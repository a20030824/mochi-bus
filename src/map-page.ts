export function renderMapPage(): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#e8e2d6">
  <meta name="description" content="把公車路線直接畫在城市裡">
  <title>公車地圖｜Mochi Bus</title>
  <link rel="stylesheet" href="/assets/map.css">
  <link rel="modulepreload" href="/assets/map.js">
  <link rel="modulepreload" href="/assets/boards.js">
  <link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin>
</head>
<body>
  <div id="map-app">
    <div id="map" aria-label="公車路線地圖"></div>
    <header class="map-header">
      <a id="map-brand" href="/map" class="map-brand" title="回到全台總覽">MOCHI <span>MAP</span></a>
      <a class="quiet-button map-home" href="/">首頁</a>
    </header>
    <div id="map-status" class="map-status">選一個區域，看看公車如何穿過城市。</div>
    <aside id="map-drawer" class="map-drawer" aria-live="polite"></aside>
  </div>
  <script type="module" src="/assets/map.js"></script>
</body>
</html>`
}
