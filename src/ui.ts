import { toBusSearchParams, type BusQuery, type ResolvedBusQuery } from './domain/bus-query'
import { tdxWarningMessages, type ETAResult, type RouteDetail, type RouteStop } from './lib/tdx'
import { canonicalUrl, renderWebsiteStructuredData, siteSearchDescription, siteSocialDescription, siteSocialImage, siteTitle } from './seo'

type ETAView = {
  query: ResolvedBusQuery
  result?: ETAResult
  error?: string
  notice?: string
  useLocalBoard: boolean
  requestUrl: string
}

export function renderETAPage(view: ETAView): string {
  const { query, result, error, notice, useLocalBoard, requestUrl } = view
  const initialBoard = {
    version: 2,
    id: 'default',
    title: query.stopName,
    buses: [query],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  // 封面標題保持通用(內容由本機看板決定);/bus 是可分享頁,
  // 標題與描述帶上路線與站牌,貼到聊天軟體的預覽卡才看得出是哪班車。
  const pageTitle = useLocalBoard ? siteTitle : `${query.routeName} · ${query.stopName}｜Mochi Bus`
  const pageDescription = useLocalBoard
    ? siteSearchDescription
    : `${query.routeName} 在${query.stopName}的即時到站時間`
  const heading = useLocalBoard ? '台灣公車到站看板' : `${query.routeName} 在 ${query.stopName} 的到站時間`
  const mapHref = `/map?city=${encodeURIComponent(query.city)}`
  // 上方已有服務橫幅(notice)時,狀態列不再重複同一句 TDX 警語。
  const warningNotice = !notice && result?.warning ? tdxWarningMessages[result.warning] : undefined
  const resultNotice = warningNotice
    ?? (result?.stale ? '資料有些延遲，以現場站牌為準' : result?.source === 'schedule' ? '依時刻表推估，實際到站可能略有出入' : error ?? '')

  return pageShell(pageTitle, `
  <main class="eta-page">
    <header class="topbar">
      <a class="brand" href="/">MOCHI BUS</a>
      <nav class="top-actions" aria-label="主要功能" style="display:flex;align-items:center;gap:8px"><a class="icon-link" style="border-color:#a9b7ad;color:var(--green-deep)" href="/map">地圖</a><a class="icon-link" href="/setup">我的公車</a></nav>
    </header>
    <section class="cover" aria-live="polite">
      <div class="onboard-sign" id="onboard-sign" hidden aria-hidden="true">
        <div class="onboard-sign-text"><span class="onboard-sign-track"><span>Understand the network first, then catch the bus.</span><span>Understand the network first, then catch the bus.</span></span></div>
      </div>
      <h1 class="eyebrow" id="board-title">${escapeHTML(heading)}</h1>
      <div class="bus-list" id="bus-list">${renderBusRow(query, result, error)}</div>
      <div class="onboard" id="onboard" hidden>
        <p>找到你每天在等的那班車，這一頁就會變成你的。</p>
        <a class="onboard-map" href="/map">地圖<span aria-hidden="true">→</span></a>
      </div>
      ${notice ? `<p class="notice service-notice">${escapeHTML(notice)}<br><a href="${escapeHTML(mapHref)}">打開地圖</a></p>` : ''}
      <p class="notice" id="notice">${escapeHTML(resultNotice)}</p>
    </section>
    <footer class="eta-footer">
      <span id="updated">${result ? `資料 ${formatTaipeiTime(result.dataTime ?? result.fetchedAt)}` : '尚未更新'}</span>
      <span class="eta-footer-actions">
        <a class="footer-action" href="/setup">管理常用站牌</a>
        <button class="primary compact" id="refresh" type="button">重新整理</button>
      </span>
    </footer>
  </main>`, { script: `<script id="eta-bootstrap" type="application/json">${safeJSON({ initialBoard, useLocalBoard, tdxWarningMessages })}</script><script type="module" src="/assets/eta.js"></script>`, description: pageDescription, canonical: canonicalUrl(requestUrl) })
}

export function renderSetupPage(cities: ReadonlyArray<readonly [string, string]>, requestUrl: string): string {
  const cityOptions = cities.map(([code, name]) => `<option value="${escapeHTML(code)}">${escapeHTML(name)}</option>`).join('')
  return pageShell('我的公車｜Mochi Bus', `
  <main class="setup-page">
    <header class="topbar"><a class="brand" href="/">MOCHI BUS</a><a class="icon-link" href="/">完成</a></header>
    <section class="panel">
      <p class="kicker">我的公車</p><h1>常用站牌</h1>
      <div id="board-list" class="board-list"></div>
      <button class="add-board-button" id="add-board-button" type="button">＋ 新增常用站牌</button>
      <details class="advanced-panel">
        <summary>進階</summary>
        <div class="advanced-section">
          <details class="glossary">
            <summary>約、稍早……那些小字是什麼意思？</summary>
            <div class="glossary-list">
              <div><b>7 分</b><span>即時 GPS 回報的到站時間，最可信的一種。</span></div>
              <div><b>約 7 分</b><span>沒有即時訊號，依時刻表推估。</span></div>
              <div><b>5–10 分一班</b><span>班距制路線（雙北常見）：官方只公布多久一班，不公布每一班的時刻。</span></div>
              <div><b>7 分後發車</b><span>這一站沒有自己的時刻，以起點發車時間當下限，車還要開過來。</span></div>
              <div><b>稍早</b><span>資料源暫時忙線，先給你幾分鐘內的最後一筆即時資料，總比空白好。</span></div>
              <div><b>明日 06:10 發車</b><span>今天收班了。超過一小時的等待一律給時刻，沒有人想心算 131 分。</span></div>
            </div>
            <p class="glossary-tip">地圖上，點任何一個站牌會同時畫出所有經過它的路線，一眼看出這一站能把你帶去哪裡。</p>
            <p class="glossary-tip">▦ 攤開整座城市的路網</p>
            <p class="glossary-tip">↗ 規劃一段行程</p>
            <p class="glossary-tip">這些小字只有一個用意：誠實標示每筆資料的可信度，寧可給推估，也不給空白。</p>
            <p class="glossary-tip">常用站牌與設定只保存在這台裝置。</p>
            <p class="glossary-tip">支援加入主畫面（PWA），下次就像 App 一樣直接打開。</p>
            <p class="glossary-tip">如果 Mochi Bus 有幫到你，歡迎使用自己的 TDX API，把共用額度留給下一位需要的人。</p>
          </details>
        </div>
        <div class="advanced-section">
          <strong>自備 TDX 憑證</strong>
          <p>向 <a href="https://tdx.transportdata.tw/" target="_blank" rel="noopener">TDX</a> 申請一組自己的憑證，即時查詢就走你自己的額度。憑證只在查詢時送到 Worker 換取 token，不寫入伺服器儲存或 log。</p>
          <div class="credential-field"><label for="tdx-client-id">Client ID</label><input id="tdx-client-id" autocomplete="off" spellcheck="false" aria-describedby="tdx-message" aria-invalid="false"></div>
          <div class="credential-field"><label for="tdx-client-secret">Client Secret</label><input id="tdx-client-secret" placeholder="Client Secret" type="password" autocomplete="off" aria-describedby="tdx-message" aria-invalid="false"></div>
          <label class="tdx-remember"><input id="tdx-remember" type="checkbox"><span><strong>記住於此裝置</strong><small>長期保存在這個瀏覽器；不勾選則關閉分頁後移除。</small></span></label>
          <div class="advanced-actions">
            <button id="tdx-save" type="button">儲存並測試</button>
            <button class="quiet-danger" id="tdx-remove" type="button" hidden>移除憑證</button>
          </div>
          <p class="form-message" id="tdx-message" aria-live="polite"></p>
        </div>
        <div class="advanced-section">
          <button class="clear-local-button" id="clear-local-button" type="button">清除本機資料</button>
          <p>常用站牌、封面設定與 TDX 憑證會一併刪除。</p>
        </div>
      </details>
      <details class="about-panel glossary">
        <summary>關於 Mochi Bus</summary>
        <p class="glossary-tip">Mochi Bus 的起點，是一次搭公車時的小抱怨：有些工具有地圖，卻不一定照顧到每個地方的即時資訊；有些工具有即時資訊，卻很難看懂路線在城市裡實際怎麼走。</p>
        <p class="glossary-tip">路線本來就應該畫在地圖上。站牌不只是等車的地方，也是一個能看見城市交通網路的節點。</p>
        <p class="glossary-tip">所以它不只想回答「我要怎麼去那裡」，也想回答「這座城市的公車是怎麼運作的」。地圖是主角，不是搜尋框；點站牌是探索，不只是查 ETA。</p>
        <p class="glossary-tip">它也不急著追蹤你現在在哪。地圖只用粗略位置猜縣市，首頁則回到你存下的常用站牌；重點是看懂路網，而不是把每一步都導航完。</p>
        <p class="glossary-thanks">公車資料來自交通部 TDX，底圖是 OpenStreetMap 貢獻者的作品，由 Cloudflare Workers 送到你手上。謝謝他們。</p>
        <p class="glossary-thanks">Mochi Bus 採 Apache-2.0 授權開源，歡迎到 <a href="https://github.com/a20030824/mochi-bus" target="_blank" rel="noopener">GitHub</a> 提出 Issue、Pull Request 或 Fork。</p>
      </details>
    </section>
    <section class="panel picker-panel" id="picker-panel" hidden>
      <div class="picker-toolbar"><strong>新增常用站牌</strong><button class="back-button" id="close-picker" type="button">取消</button></div>
      <div id="route-picker">
        <div class="picker-head">
          <label>縣市<select id="city">${cityOptions}</select></label>
          <label>快速篩選<input id="route-filter" placeholder="輸入幾個字即可，不必完整名稱" autocomplete="off"></label>
        </div>
        <div class="category-list" id="categories"></div>
        <p class="form-message" id="message" aria-live="polite">準備載入路線</p>
        <div class="route-grid" id="route-grid"></div>
      </div>
      <div class="step" id="direction-step" hidden></div>
      <div class="step" id="suggestion-step" hidden></div>
    </section>
  </main>`, { script: setupScript(), description: siteSearchDescription, noindex: true, canonical: canonicalUrl(requestUrl) })
}

export function renderRoutePage(query: ResolvedBusQuery, detail: RouteDetail, requestUrl: string): string {
  const stops = detail.stops.map((stop) => `<li class="route-stop${stop.selected ? ' selected' : ''}"><span class="dot"></span><div><strong>${escapeHTML(stop.stopName)}</strong>${stop.selected ? '<em>你的站牌</em>' : ''}</div><span>${escapeHTML(stop.etaLabel ?? '')}</span></li>`).join('')
  return pageShell(`${query.routeName} 路線｜Mochi Bus`, `<main class="route-page"><header class="topbar"><a class="icon-link" href="javascript:history.back()">返回</a><a class="brand" href="/">MOCHI BUS</a></header><section class="route-head"><span class="route-badge">${escapeHTML(query.routeName)}</span><h1>${escapeHTML(`${query.routeName} · ${detail.label}`)}</h1><p>你等車的位置已經標好</p></section><ol class="route-timeline">${stops}</ol></main>`, { description: `${query.routeName}(${detail.label})的完整站序與各站到站時間`, canonical: canonicalUrl(requestUrl) })
}

export type ErrorPageView = {
  title: string
  message: string
  actionsHTML: string
  requestUrl: string
}

// /bus、/route 出錯時的頁面殼:跟正常頁共用 topbar 與面板樣式。
// 出錯的當下使用者更需要「還在同一個網站」的安心感,不能長得像 crash dump。
export function renderErrorPage(view: ErrorPageView): string {
  return pageShell(`${view.title}｜Mochi Bus`, `
  <main class="setup-page">
    <header class="topbar"><a class="brand" href="/">MOCHI BUS</a><a class="icon-link" href="/map">地圖</a></header>
    <section class="panel">
      <p class="kicker">出了點狀況</p>
      <h1 class="error-title">${escapeHTML(view.title)}</h1>
      <p class="error-copy">${escapeHTML(view.message)}</p>
      <div class="error-links">${view.actionsHTML}</div>
    </section>
  </main>`, { canonical: canonicalUrl(view.requestUrl), noindex: true })
}

export function renderAmbiguousPage(query: BusQuery, candidates: RouteStop[], requestUrl: string): string {
  const links = candidates.map((candidate) => {
    const resolved: ResolvedBusQuery = { ...query, routeUid: query.routeUid ?? candidate.routeUid, stopName: candidate.stopName, stopUid: candidate.stopUid }
    return `<a class="choice" href="/bus?${escapeHTML(toBusSearchParams(resolved).toString())}"><strong>${escapeHTML(candidate.subRouteName)}</strong><span>${escapeHTML(candidate.stopName)}</span></a>`
  }).join('')
  return pageShell('選擇路線｜Mochi Bus', `<main class="setup-page"><header class="topbar"><a class="brand" href="/">MOCHI BUS</a></header><section class="panel"><p class="kicker">同名站牌</p><h1>選擇你搭的支線</h1><div class="choices">${links}</div></section></main>`, { canonical: canonicalUrl(requestUrl) })
}

// setup 頁的互動邏輯已搬到 web/setup/main.ts,由 Vite 建置、納入
// TypeScript/lint/test(ARCH-001);這裡只負責掛上建好的 script 標籤。
function setupScript(): string {
  return '<script type="module" src="/assets/setup.js"></script>'
}

function renderBusRow(query: ResolvedBusQuery, result?: ETAResult, error?: string): string {
  return `<a class="bus-row" href="/route?${escapeHTML(toBusSearchParams(query).toString())}"><strong class="bus-name">${escapeHTML(query.routeName)}</strong><span class="bus-eta">${escapeHTML(result?.label ?? error ?? '更新中')}</span></a>`
}

export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#f7f2e8"/><rect x="92" y="110" width="328" height="246" rx="80" fill="#df7357"/><rect x="132" y="154" width="248" height="96" rx="30" fill="#fffaf0"/><circle cx="170" cy="356" r="42" fill="#29251f"/><circle cx="342" cy="356" r="42" fill="#29251f"/><path d="M170 292h172" stroke="#29251f" stroke-width="24" stroke-linecap="round"/></svg>`

type PageShellOptions = {
  canonical: string
  script?: string
  description?: string
  noindex?: boolean
}

// canonical 沒有預設值:硬性要求每個呼叫點都想清楚自己的實際請求網址,
// 用物件參數而非一長串位置參數,也是為了不再重演 script/description 位置錯位的問題。
function pageShell(title: string, body: string, options: PageShellOptions): string {
  const { canonical, script = '', description = siteSearchDescription, noindex = false } = options
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f2e8"><meta name="description" content="${escapeHTML(description)}">${noindex ? '<meta name="robots" content="noindex">' : ''}<link rel="canonical" href="${escapeHTML(canonical)}"><meta property="og:title" content="${escapeHTML(title)}"><meta property="og:description" content="${escapeHTML(siteSocialDescription)}"><meta property="og:site_name" content="Mochi Bus"><meta property="og:url" content="${escapeHTML(canonical)}"><meta property="og:image" content="${siteSocialImage}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHTML(title)}"><meta name="twitter:description" content="${escapeHTML(siteSocialDescription)}"><meta name="twitter:image" content="${siteSocialImage}">${renderWebsiteStructuredData()}<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><title>${escapeHTML(title)}</title><style>${styles}${enhancementStyles}${credentialStyles}${designRefinementStyles}</style></head><body>${body}${script}</body></html>`
}

// 色彩 token 與地圖(web/map/style.css)共用同一組 accent/green/ink 值,
// 兩頁的人格差異(圓潤 vs 製圖)留給字體與圓角表達,中性色各自維持調性。
const styles = `:root{color-scheme:light;--ink:#29251f;--paper:#f7f2e8;--surface:#fffaf0;--line:#d8d0c2;--muted:#777066;--accent:#b85f49;--accent-deep:#9b4735;--green:#4f685b;--green-deep:#3f594c;font-family:ui-rounded,"SF Pro Rounded","PingFang TC",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#f7f2e8;color:#29251f}a{color:inherit}.eta-page,.setup-page,.route-page{width:min(100%,720px);min-height:100svh;margin:0 auto;padding:max(26px,env(safe-area-inset-top)) 22px max(28px,env(safe-area-inset-bottom))}.eta-page{display:flex;flex-direction:column}.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px}.brand{text-decoration:none;font-size:15px;font-weight:850;letter-spacing:.04em}.icon-link{padding:9px 12px;border:1px solid #d8d0c2;border-radius:999px;text-decoration:none;font-size:14px;font-weight:750}.cover{flex:1;display:grid;align-content:center;padding:52px 0 36px}.eyebrow{margin:0 0 18px;color:#716a60;font-size:18px;font-weight:800}.bus-list{display:grid}.bus-row{display:grid;grid-template-columns:minmax(80px,1fr) auto;align-items:baseline;gap:18px;padding:17px 0;border-bottom:1px solid #ddd3c4;text-decoration:none}.bus-name{font-size:clamp(30px,10vw,54px);letter-spacing:-.04em}.bus-eta{font-size:clamp(27px,9vw,50px);font-weight:900;letter-spacing:-.05em;font-variant-numeric:tabular-nums;white-space:nowrap}.notice{min-height:22px;color:var(--accent-deep);font-size:14px;font-weight:700}.service-notice{margin:18px 0 0;line-height:1.65}.service-notice a{font-weight:850;text-decoration:underline;text-underline-offset:3px}.eta-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#777066;font-size:13px}.primary,button{appearance:none;border:0;border-radius:12px;padding:12px 17px;background:var(--accent);color:white;font:inherit;font-weight:800;cursor:pointer}.primary.compact{border-radius:999px}.primary:disabled,button:disabled{opacity:.55;cursor:wait}.setup-page{display:flex;flex-direction:column;gap:22px}.panel{margin-top:18px;padding:24px;border:1px solid #ded6c9;border-radius:24px;background:rgba(255,250,240,.62)}.panel h1{margin:8px 0 24px;font-size:clamp(38px,10vw,62px);line-height:1.02;letter-spacing:-.05em}.kicker{margin:0;color:var(--accent-deep);font-size:13px;font-weight:850;letter-spacing:.08em}.board-list,.step,.choices{display:grid;gap:12px}.board-item,.result-card,.choice{padding:16px;border:1px solid #ded6c9;border-radius:17px;background:#fffaf0}.board-item{display:flex;align-items:center;justify-content:space-between;gap:15px}.board-item>div:first-child{display:grid;gap:5px}.board-item span,.result-card p,.choice span{color:#777066;font-size:13px}.item-actions{display:flex;gap:7px}.item-actions button{background:transparent;color:var(--accent-deep);padding:6px;font-size:13px}.flow-steps{display:flex;gap:7px;margin:14px 0 18px;overflow:auto}.flow-steps span{flex:none;padding:7px 10px;border-radius:999px;background:#e9e1d5;color:#777066;font-size:12px;font-weight:800}.flow-steps span.active{background:#29251f;color:#fffaf0}.flow-steps span.done{background:rgba(184,95,73,.2);color:var(--accent-deep)}.picker-head{display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:14px}.picker-head label{display:grid;gap:7px;color:#716a60;font-size:13px;font-weight:750}select,input{width:100%;border:1px solid #d8d0c2;border-radius:12px;background:#fffaf0;color:#29251f;padding:11px 12px;font:inherit}.category-list{display:flex;gap:7px;overflow:auto;padding:4px 0 12px}.chip{flex:none;border:1px solid #d8d0c2;background:transparent;color:#716a60;border-radius:999px;padding:7px 12px;font-size:13px}.chip.active{background:#29251f;color:#fffaf0}.form-message{color:#777066;font-size:13px}.route-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:330px;overflow:auto}.route-grid::after{content:"";position:sticky;bottom:0;grid-column:1/-1;height:26px;margin-top:-26px;background:linear-gradient(to bottom,rgba(252,247,237,0),rgba(252,247,237,.96));opacity:0;transition:opacity .18s ease;pointer-events:none}.route-grid.scrollable-below::after{opacity:1}.route-choice{display:grid;gap:4px;background:#fffaf0;color:#29251f;border:1px solid #ded6c9;padding:11px 12px;text-align:left}.route-choice b{font-size:15px}.route-choice small{overflow:hidden;color:#777066;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.step{margin-top:24px;padding-top:20px;border-top:1px solid #ded6c9}.step-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.back-button{padding:7px 0;background:transparent;color:var(--accent-deep)}.result-card{display:grid;gap:12px}.result-card h2{margin:0;font-size:17px}.result-card p{margin:0}.suggestion-list{display:grid;gap:8px}.check-row{display:flex;align-items:center;gap:10px;padding:11px;border:1px solid #ded6c9;border-radius:12px}.check-row.selected{border-color:var(--accent);background:rgba(184,95,73,.06)}.check-row input{width:auto}.check-row span{flex:1}.check-row em{flex:none;color:var(--accent-deep);font-size:11px;font-style:normal;font-weight:850}.choice{display:grid;gap:5px;text-decoration:none}.empty{color:#777066}.undo-toast{position:fixed;left:50%;bottom:max(24px,env(safe-area-inset-bottom));z-index:10;width:min(calc(100% - 32px),520px);transform:translateX(-50%);display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 16px;border-radius:15px;background:#29251f;color:#fffaf0;box-shadow:0 12px 40px #0004;font-weight:750}.undo-toast[hidden]{display:none}.undo-toast button{padding:7px 9px;background:transparent;color:#f09b80}.route-page{padding-bottom:60px}.route-head{padding:48px 0 28px}.route-badge{display:inline-block;padding:9px 14px;border-radius:999px;background:#29251f;color:#fffaf0;font-weight:850}.route-head h1{margin:18px 0 8px;font-size:clamp(28px,8vw,48px);line-height:1.08;letter-spacing:-.04em}.route-head p{color:#777066}.route-timeline{list-style:none;margin:0;padding:0}.route-stop{position:relative;display:grid;grid-template-columns:24px 1fr auto;gap:12px;min-height:58px}.route-stop:before{content:"";position:absolute;left:8px;top:18px;bottom:-4px;width:2px;background:#d8d0c2}.route-stop:last-child:before{display:none}.dot{position:relative;z-index:1;width:18px;height:18px;border:4px solid #f7f2e8;border-radius:50%;background:#aaa197}.route-stop.selected .dot{background:var(--accent);box-shadow:0 0 0 3px rgba(184,95,73,.27)}.route-stop div{display:flex;gap:8px;align-items:flex-start}.route-stop em{color:var(--accent);font-size:12px;font-style:normal;font-weight:800}.route-stop>span:last-child{color:#777066;font-size:14px;font-weight:700}@media(max-width:520px){.picker-head{grid-template-columns:1fr}.board-item{align-items:flex-start;flex-direction:column}.bus-row{grid-template-columns:1fr auto}.item-actions{flex-wrap:wrap}}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--accent:#df7357;--accent-deep:#f09b80}.route-grid::after{background:linear-gradient(to bottom,rgba(42,39,34,0),rgba(42,39,34,.96))}body{background:#211f1b;color:#f8f0e3}.panel{border-color:#464139;background:#2a2722}.board-item,.result-card,.choice,input,select,.route-choice,.check-row{border-color:#4d473e;background:#302c26;color:#f8f0e3}.icon-link,.chip{border-color:#4d473e}.chip.active,.route-badge,.flow-steps span.active{background:#f8f0e3;color:#211f1b}.bus-row,.step{border-color:#4d473e}.eyebrow,.eta-footer,.board-item span,.result-card p,.choice span,.route-head p,.route-stop>span:last-child{color:#aaa197}.route-stop:before{background:#4d473e}.route-stop .dot{border-color:#211f1b}.notice{color:#f09b80}}`

const enhancementStyles = `.onboard-sign{position:relative;overflow:hidden;margin:0 0 26px;padding:12px 0;border-radius:9px;background:#211e19;box-shadow:inset 0 0 0 1px #3a3426,inset 0 5px 16px #000c,0 3px 14px #2922141f}.onboard-sign::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,#0000 0 2px,#0005 2px 3px),repeating-linear-gradient(0deg,#0000 0 2px,#0005 2px 3px);pointer-events:none}.onboard-sign-track{display:flex;gap:72px;width:max-content;animation:onboard-sign-scroll 18s linear infinite}.onboard-sign:hover .onboard-sign-track{animation-play-state:paused}.onboard-sign-track span{white-space:nowrap;color:#ffb23e;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:800;letter-spacing:.24em;text-transform:uppercase;text-shadow:0 0 8px #ffb23e99,0 0 2px #ffb23e}@keyframes onboard-sign-scroll{from{transform:translateX(0)}to{transform:translateX(calc(-50% - 36px))}}@media(prefers-reduced-motion:reduce){.onboard-sign-track{width:100%;justify-content:center;animation:none}.onboard-sign-track span+span{display:none}.onboard-sign-track span{padding:0 14px;white-space:normal;text-align:center;letter-spacing:.12em;line-height:1.7}}.onboard{display:grid;gap:16px;margin-top:30px}.onboard[hidden]{display:none}.onboard p{margin:0 2px;color:#716a60;font-size:14.5px;font-weight:650;line-height:1.8;letter-spacing:.01em}.onboard-map{display:flex;align-items:center;justify-content:space-between;padding:19px 22px;border-radius:18px;background:#29251f;color:#fffaf0;font-size:19px;font-weight:850;letter-spacing:.2em;text-decoration:none}.onboard-map span{font-size:21px;letter-spacing:0;transition:transform .18s ease}.onboard-map:hover span,.onboard-map:focus-visible span{transform:translateX(5px)}.add-board-button{width:100%;margin-top:14px;background:transparent;color:var(--accent-deep);border:1px dashed #d0b7a9}.clear-local-button{width:100%;padding:8px;background:transparent;color:var(--accent-deep);font-size:13px;border:1px solid #d8d0c2;border-radius:12px}.advanced-panel{margin-top:22px;border-top:1px solid #ded6c9}.advanced-panel>summary{padding:13px 0 5px;color:#777066;font-size:13px;font-weight:750;cursor:pointer;list-style:none}.advanced-panel>summary::-webkit-details-marker{display:none}.advanced-panel>summary::before{content:'▸ '}.advanced-panel[open]>summary::before{content:'▾ '}.advanced-section{display:grid;gap:10px;padding:14px 0}.advanced-section+.advanced-section{border-top:1px solid #e7dfd2}.advanced-section strong{font-size:14px}.advanced-section p{margin:0;color:#777066;font-size:13px;line-height:1.6}.advanced-section a{color:var(--accent-deep)}.advanced-actions{display:flex;gap:8px}.advanced-actions button{flex:1}.quiet-danger{background:transparent;color:var(--accent-deep);border:1px solid #d8d0c2}.glossary summary{padding:2px 0;color:var(--accent-deep);font-size:13px;font-weight:750;cursor:pointer;list-style:none}.glossary summary::-webkit-details-marker{display:none}.glossary summary::before{content:'▸ '}.glossary[open] summary::before{content:'▾ '}.glossary-list{display:grid;gap:9px;margin:14px 0 12px}.glossary-list div{display:grid;grid-template-columns:108px 1fr;gap:10px;font-size:13px}.glossary-list b{color:#29251f;font-variant-numeric:tabular-nums;line-height:1.55}.glossary-list span{color:#777066;line-height:1.55}.glossary-tip{margin:0 0 10px}.glossary-thanks{margin:2px 0 0;color:#9a9184;font-size:12px;line-height:1.6}.picker-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.board-item{max-height:110px;overflow:hidden;transition:max-height .26s ease,opacity .2s ease,transform .2s ease,background-color .2s ease}.board-item.deleted{justify-content:space-between;background:#29251f;color:#fffaf0}.board-item.deleted span{color:#fffaf0}.board-item.collapsing{max-height:0;min-height:0;padding-top:0;padding-bottom:0;margin:0;opacity:0;transform:scale(.97)}.board-item.restoring{background:rgba(184,95,73,.2);transform:scale(1.01)}.inline-undo{padding:7px 10px;background:transparent;color:#f09b80}.suggestion-copy{display:grid;gap:3px;min-width:0}.suggestion-main{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.suggestion-main strong{font-size:17px}.suggestion-main b{white-space:nowrap;font-size:15px}.suggestion-copy small{overflow:hidden;color:#777066;text-overflow:ellipsis;white-space:nowrap}.sticky-save{position:sticky;bottom:max(12px,env(safe-area-inset-bottom));z-index:3;width:100%;box-shadow:0 10px 28px #0003}@media(prefers-color-scheme:dark){.onboard p{color:#aaa197}.onboard-map{background:#f8f0e3;color:#211f1b}.advanced-panel{border-color:#4d473e}.advanced-section+.advanced-section{border-color:#3a362f}.advanced-section p{color:#aaa197}.clear-local-button,.quiet-danger{border-color:#4d473e}.glossary summary{color:#f09b80}.glossary-list b{color:#f8f0e3}.glossary-list span{color:#aaa197}.glossary-thanks{color:#aaa197}.add-board-button{border-color:#694d43}.clear-local-button{color:#f09b80}.board-item.deleted{background:#f8f0e3;color:#211f1b}.board-item.deleted span{color:#211f1b}.suggestion-copy small{color:#aaa197}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}`

const credentialStyles = `.credential-field{display:grid;gap:6px}.credential-field>label{color:#716a60;font-size:13px;font-weight:750}.credential-field input[aria-invalid="true"]{border-color:var(--accent-deep)}.tdx-remember{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #ded6c9;border-radius:12px;cursor:pointer}.tdx-remember input{flex:none;width:18px;height:18px;margin:2px 0 0;padding:0;border-radius:4px;background:transparent;accent-color:var(--accent)}.tdx-remember span{display:grid;gap:3px}.tdx-remember strong{font-size:14px}.tdx-remember small{color:#777066;font-size:13px;line-height:1.5}.form-message.form-message-error{color:var(--accent-deep);font-weight:750}.panel h1.error-title{font-size:clamp(26px,7vw,40px);line-height:1.15;letter-spacing:-.03em}.error-copy{margin:0 0 20px;color:#777066;font-size:15px;line-height:1.75}.error-links{display:flex;flex-wrap:wrap;gap:16px}.error-links a{color:var(--accent-deep);font-weight:750;text-underline-offset:3px}@media(prefers-color-scheme:dark){.credential-field>label,.tdx-remember small{color:#aaa197}.tdx-remember{border-color:#4d473e}.credential-field input[aria-invalid="true"]{border-color:#f09b80}.form-message.form-message-error{color:#f09b80}.error-copy{color:#aaa197}.error-links a{color:#f09b80}}`

const designRefinementStyles = `
.onboard-sign-text{position:relative;z-index:1;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 32px,#000 calc(100% - 32px),transparent);mask-image:linear-gradient(90deg,transparent,#000 32px,#000 calc(100% - 32px),transparent)}
.onboard-sign::after{z-index:2}
.advanced-panel>summary,.glossary summary{color:#777066}
.eta-footer-actions{display:flex;align-items:center;gap:8px}
.footer-action{padding:10px 14px;border:1px solid #d8d0c2;border-radius:999px;color:inherit;font-weight:750;text-decoration:none}
.about-panel{margin-top:14px;padding-top:13px;border-top:1px solid #ded6c9}
.about-panel p{color:#777066;font-size:13px;line-height:1.65}
.about-panel a{color:var(--accent-deep)}
.add-board-button.empty-state{border-style:solid;border-color:#29251f;background:#29251f;color:#fffaf0}
@media(min-width:900px){
  .setup-page{width:min(100%,664px)}
  .onboard-sign{width:min(100%,560px);margin-right:auto;margin-left:auto}
  .bus-name{font-size:clamp(54px,5vw,72px)}
}
@media(max-width:560px){
  .eta-footer{align-items:flex-start;flex-direction:column}
  .eta-footer-actions{width:100%}
  .eta-footer-actions>*{flex:1;text-align:center}
}
@media(prefers-color-scheme:dark){
  .advanced-panel>summary,.glossary summary{color:#aaa197}
  .footer-action{border-color:#4d473e}
  .about-panel{border-color:#4d473e}
  .about-panel p{color:#aaa197}
  .add-board-button.empty-state{border-color:#f8f0e3;background:#f8f0e3;color:#211f1b}
}`

function escapeHTML(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;') }
function safeJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
function formatTaipeiTime(value: string): string { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) }
