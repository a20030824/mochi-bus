import { toBusSearchParams, type BusQuery, type ResolvedBusQuery } from './domain/bus-query'
import type { ETAResult, RouteDetail, RouteStop } from './lib/tdx'

type ETAView = {
  query: ResolvedBusQuery
  result?: ETAResult
  error?: string
  useLocalBoard: boolean
}

export function renderETAPage(view: ETAView): string {
  const { query, result, error, useLocalBoard } = view
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
  const pageTitle = useLocalBoard ? 'Mochi Bus' : `${query.routeName} · ${query.stopName}｜Mochi Bus`
  const pageDescription = useLocalBoard
    ? '一眼查看常用站牌的公車到站時間'
    : `${query.routeName} 在${query.stopName}的即時到站時間`

  return pageShell(pageTitle, `
  <main class="eta-page">
    <header class="topbar">
      <a class="brand" href="/">MOCHI BUS</a>
      <nav class="top-actions" aria-label="主要功能" style="display:flex;align-items:center;gap:8px"><a class="icon-link" style="border-color:#a9b7ad;color:#3f594c" href="/map">地圖</a><a class="icon-link" href="/setup">我的公車</a></nav>
    </header>
    <section class="cover" aria-live="polite">
      <div class="onboard-sign" id="onboard-sign" hidden aria-hidden="true">
        <span class="onboard-sign-track"><span>Understand the network first, then catch the bus.</span><span>Understand the network first, then catch the bus.</span></span>
      </div>
      <p class="eyebrow" id="board-title">${escapeHTML(query.stopName)}</p>
      <div class="bus-list" id="bus-list">${renderBusRow(query, result, error)}</div>
      <div class="onboard" id="onboard" hidden>
        <p>找到你每天在等的那班車，這一頁就會變成你的。</p>
        <a class="onboard-map" href="/map">地圖<span aria-hidden="true">→</span></a>
      </div>
      <p class="notice" id="notice">${escapeHTML(result?.stale ? '資料有些延遲，以現場站牌為準' : result?.source === 'schedule' ? '依時刻表推估，實際到站可能略有出入' : error ?? '')}</p>
    </section>
    <footer class="eta-footer">
      <span id="updated">${result ? `資料 ${formatTaipeiTime(result.dataTime ?? result.fetchedAt)}` : '尚未更新'}</span>
      <span style="display:flex;align-items:center;gap:16px">
        <a href="/setup" style="color:inherit;font-weight:750;text-decoration:none;border-bottom:1px solid currentColor">管理常用站牌</a>
        <button class="primary compact" id="refresh" type="button">重新整理</button>
      </span>
    </footer>
  </main>`, `
  <script type="module">
    import { activeBoardId, migrateBoards, setActiveCity, syncActiveBoard, tdxHeaders, writeBoards } from '/assets/boards.js';
    const initialBoard = ${safeJSON(initialBoard)};
    const useLocalBoard = ${useLocalBoard};
    let currentBoard = initialBoard;
    // 示範模式:使用者還沒有任何常用站牌,封面顯示示範站牌與導引,不寫入本機資料。
    let demoBoard = false;
    const listNode = document.querySelector('#bus-list');
    const titleNode = document.querySelector('#board-title');
    const noticeNode = document.querySelector('#notice');
    const updatedNode = document.querySelector('#updated');
    const refreshButton = document.querySelector('#refresh');
    const topActionLinks = document.querySelectorAll('.top-actions a');
    const mapLink = topActionLinks[0];
    mapLink.removeAttribute('style');
    if (topActionLinks[1]) topActionLinks[1].remove();

    function paramsFor(bus) {
      const params = new URLSearchParams({ city: bus.city || currentBoard.city, route: bus.routeName, direction: String(bus.direction) });
      if (bus.stopName) params.set('stop', bus.stopName);
      if (bus.stopUid) params.set('stopUid', bus.stopUid);
      if (bus.routeUid) params.set('routeUid', bus.routeUid);
      if (bus.subRouteUid) params.set('subRouteUid', bus.subRouteUid);
      return params;
    }

    function routeLink(bus) {
      if (bus.stopName && bus.stopUid) return '/route?' + paramsFor(bus);
      return '#';
    }

    function makeRow(bus, data, failed = false) {
      const link = document.createElement('a');
      link.className = 'bus-row';
      link.href = routeLink(bus);
      const routeCopy = document.createElement('span');
      routeCopy.className = 'bus-route-copy';
      routeCopy.style.cssText = 'display:grid;min-width:0;gap:3px';
      const route = document.createElement('strong');
      route.className = 'bus-name';
      route.textContent = bus.routeName;
      const direction = document.createElement('small');
      direction.className = 'bus-direction';
      direction.textContent = bus.directionLabel || '';
      direction.hidden = !bus.directionLabel;
      direction.style.cssText = 'overflow:hidden;color:#777066;font-size:13px;font-weight:700;text-overflow:ellipsis;white-space:nowrap';
      routeCopy.append(route, direction);
      const eta = document.createElement('span');
      eta.className = 'bus-eta';
      eta.textContent = failed ? '暫無資料' : data?.label || '更新中';
      if (!failed && data?.source === 'stale-realtime') {
        const freshness = document.createElement('small');
        freshness.textContent = '稍早';
        freshness.style.cssText = 'margin-left:7px;color:#777066;font-size:11px;font-weight:750;letter-spacing:0';
        eta.appendChild(freshness);
      }
      link.append(routeCopy, eta);
      return link;
    }

    async function fillDirectionLabel(bus) {
      if (bus.directionLabel) return;
      try {
        const params = new URLSearchParams({ city: bus.city, route: bus.routeName });
        const response = await fetch('/api/v1/stops?' + params, { headers: tdxHeaders() });
        const body = await response.json();
        const group = body.groups?.find(group => group.direction === bus.direction && group.stops?.some(stop => stop.stopUid === bus.stopUid));
        if (group?.label) bus.directionLabel = group.label;
      } catch {}
    }

    let placeRoutesPromise;
    async function repairBusFromPlace(bus) {
      if (bus.stopName && bus.stopUid) return true;
      const city = bus.city || currentBoard.city;
      if (!city) return false;
      try {
        if (currentBoard.placeId) {
          // 失敗的 promise 不能快取,否則一次網路失敗會讓修復永遠癱瘓到重新整理為止。
          placeRoutesPromise ||= fetch('/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/routes?city=' + encodeURIComponent(city))
            .then(response => response.ok ? response.json() : Promise.reject())
            .catch(error => { placeRoutesPromise = undefined; throw error; });
          const body = await placeRoutesPromise;
          const candidates = (body.routes || []).filter(route =>
            route.routeName === bus.routeName
            && route.direction === bus.direction
            && (!bus.routeUid || route.routeUid === bus.routeUid));
          const match = candidates.find(route => !bus.directionLabel || route.label === bus.directionLabel) || candidates[0];
          if (match) {
            bus.city = city;
            bus.routeUid = match.routeUid;
            bus.subRouteUid = match.subRouteUid;
            bus.stopName = match.stopName;
            bus.stopUid = match.stopUid;
            bus.directionLabel = match.label;
            return true;
          }
        }
        const params = new URLSearchParams({ city, route: bus.routeName });
        const response = await fetch('/api/v1/stops?' + params, { headers: tdxHeaders() });
        const body = await response.json();
        if (!response.ok) return false;
        const groups = (body.groups || []).filter(group =>
          group.direction === bus.direction
          && (!bus.directionLabel || group.label === bus.directionLabel));
        const matches = groups.flatMap(group => group.stops
          .filter(stop => stop.stopName === currentBoard.title)
          .map(stop => ({ group, stop })));
        if (matches.length !== 1) return false;
        bus.city = city;
        bus.routeUid = matches[0].stop.routeUid || bus.routeUid;
        bus.subRouteUid = matches[0].stop.subRouteUid || bus.subRouteUid;
        bus.stopName = matches[0].stop.stopName;
        bus.stopUid = matches[0].stop.stopUid;
        bus.directionLabel = matches[0].group.label;
        return true;
      } catch { return false; }
    }

    async function loadPlaceArrivals() {
      const city = currentBoard.city || currentBoard.buses[0]?.city;
      if (!city || !currentBoard.placeId) return null;
      try {
        const params = new URLSearchParams({ city });
        const focus = currentBoard.buses[0];
        if (focus?.stopUid) params.set('focusStopUid', focus.stopUid);
        if (focus?.subRouteUid) params.set('focusSubRouteUid', focus.subRouteUid);
        if (focus && (focus.direction === 0 || focus.direction === 1)) params.set('focusDirection', String(focus.direction));
        const response = await fetch('/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/arrivals?' + params, { cache: 'no-store', headers: tdxHeaders() });
        const body = await response.json();
        return response.ok && Array.isArray(body.routes) ? body.routes : null;
      } catch { return null; }
    }

    async function refreshBoard() {
      // 定時器與 visibilitychange 可能同時觸發,更新中就別再疊一輪。
      if (refreshButton.disabled) return;
      refreshButton.disabled = true;
      refreshButton.textContent = '更新中';
      noticeNode.textContent = '';
      const placeArrivals = await loadPlaceArrivals();
      const responses = await Promise.all(currentBoard.buses.map(async bus => {
        const repaired = await repairBusFromPlace(bus);
        // 沒有站牌識別就不打 ETA,避免必然的 400。
        if (!repaired || (!bus.stopUid && !bus.stopName)) return { bus, failed: true };
        await fillDirectionLabel(bus);
        if (placeArrivals) {
          const arrival = placeArrivals.find(route =>
            route.routeUid === bus.routeUid
            && route.stopUid === bus.stopUid
            && route.direction === bus.direction
            && (!bus.subRouteUid || !route.subRouteUid || route.subRouteUid === bus.subRouteUid));
          if (!arrival) return { bus, failed: true };
          return { bus, data: {
            label: arrival.etaLabel,
            estimateSeconds: arrival.estimateSeconds,
            source: arrival.source,
            fetchedAt: new Date().toISOString(),
            dataTime: null,
            stale: false,
          }};
        }
        try {
          const response = await fetch('/api/v1/eta?' + paramsFor(bus), { cache: 'no-store', headers: tdxHeaders() });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error);
          return { bus, data: body };
        } catch { return { bus, failed: true }; }
      }));
      responses.sort((a, b) => {
        const aEta = typeof a.data?.estimateSeconds === 'number' ? a.data.estimateSeconds : Number.POSITIVE_INFINITY;
        const bEta = typeof b.data?.estimateSeconds === 'number' ? b.data.estimateSeconds : Number.POSITIVE_INFINITY;
        return aEta - bEta || a.bus.routeName.localeCompare(b.bus.routeName, 'zh-Hant', { numeric: true });
      });
      listNode.replaceChildren(...responses.map(item => makeRow(item.bus, item.data, item.failed)));
      if (useLocalBoard && !demoBoard) writeBoards(migrateBoards().map(board => board.id === currentBoard.id ? currentBoard : board));
      const fresh = responses.filter(item => item.data).map(item => item.data);
      if (fresh.some(item => item.stale)) noticeNode.textContent = '部分資料有些延遲，以現場站牌為準';
      else if (fresh.some(item => item.source === 'schedule')) noticeNode.textContent = '部分依時刻表推估，實際到站可能略有出入';
      updatedNode.textContent = fresh[0] ? '資料 ' + new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(fresh[0].dataTime || fresh[0].fetchedAt)) : '暫時無法更新';
      refreshButton.disabled = false;
      refreshButton.textContent = '重新整理';
    }

    if (useLocalBoard) {
      const storedBoards = migrateBoards();
      const boards = storedBoards.filter(board => !(board.placeId && board.buses?.length > 1 && board.buses.every(bus => !bus.directionLabel)));
      if (boards.length !== storedBoards.length) {
        writeBoards(boards);
        syncActiveBoard(boards);
      }
      demoBoard = !boards.length;
      if (demoBoard) {
        boards.push(initialBoard);
        document.querySelector('#onboard').hidden = false;
        document.querySelector('#onboard-sign').hidden = false;
      }
      const activeId = activeBoardId() || boards[0].id;
      currentBoard = boards.find(item => item.id === activeId) || boards[0];
      titleNode.textContent = demoBoard ? '示範 · ' + currentBoard.title : currentBoard.title;
      const firstBus = currentBoard.buses[0];
      const city = currentBoard.city || firstBus?.city;
      // 示範看板的城市(config.ts 的預設值)不是使用者選的,不能寫進 activeCity——
      // 否則使用者從沒去過台北,打開地圖卻直接跳台北而不是台灣總覽。
      if (city && !demoBoard) {
        setActiveCity(city);
        const mapParams = new URLSearchParams({ city });
        if (currentBoard.placeId) mapParams.set('place', currentBoard.placeId);
        mapLink.href = '/map?' + mapParams;
      }
      if (currentBoard.id !== initialBoard.id || currentBoard.buses.length > 1 || firstBus?.stopUid !== initialBoard.buses[0].stopUid || firstBus?.routeName !== initialBoard.buses[0].routeName || firstBus?.direction !== initialBoard.buses[0].direction) {
        listNode.replaceChildren(...currentBoard.buses.map(bus => makeRow(bus)));
        refreshBoard();
      } else refreshBoard();
    }
    refreshButton.addEventListener('click', refreshBoard);
    setInterval(() => { if (!document.hidden) refreshBoard(); }, 30_000);
    // 通勤時是「從口袋掏出來瞄一眼」:切回前景那一刻就要是最新的,不能等下一輪定時器。
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBoard(); });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  </script>`, pageDescription)
}

export function renderSetupPage(cities: ReadonlyArray<readonly [string, string]>): string {
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
            <p class="glossary-thanks">公車資料來自交通部 TDX，底圖是 OpenStreetMap 貢獻者的作品，由 Cloudflare Workers 送到你手上。謝謝他們。</p>
          </details>
        </div>
        <div class="advanced-section">
          <strong>自備 TDX 憑證</strong>
          <p>向 <a href="https://tdx.transportdata.tw/" target="_blank" rel="noopener">TDX</a> 申請一組自己的憑證，即時查詢就走你自己的額度。憑證只存在這台裝置，不會交給伺服器保管。</p>
          <input id="tdx-client-id" placeholder="Client ID" autocomplete="off" spellcheck="false">
          <input id="tdx-client-secret" placeholder="Client Secret" type="password" autocomplete="off">
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
  </main>`, setupScript())
}

export function renderRoutePage(query: ResolvedBusQuery, detail: RouteDetail): string {
  const stops = detail.stops.map((stop) => `<li class="route-stop${stop.selected ? ' selected' : ''}"><span class="dot"></span><div><strong>${escapeHTML(stop.stopName)}</strong>${stop.selected ? '<em>你的站牌</em>' : ''}</div><span>${escapeHTML(stop.etaLabel ?? '')}</span></li>`).join('')
  return pageShell(`${query.routeName} 路線｜Mochi Bus`, `<main class="route-page"><header class="topbar"><a class="icon-link" href="javascript:history.back()">返回</a><a class="brand" href="/">MOCHI BUS</a></header><section class="route-head"><span class="route-badge">${escapeHTML(query.routeName)}</span><h1>${escapeHTML(detail.label)}</h1><p>你等車的位置已經標好</p></section><ol class="route-timeline">${stops}</ol></main>`, '', `${query.routeName}(${detail.label})的完整站序與各站到站時間`)
}

export function renderAmbiguousPage(query: BusQuery, candidates: RouteStop[]): string {
  const links = candidates.map((candidate) => {
    const resolved: ResolvedBusQuery = { ...query, routeUid: query.routeUid ?? candidate.routeUid, stopName: candidate.stopName, stopUid: candidate.stopUid }
    return `<a class="choice" href="/bus?${escapeHTML(toBusSearchParams(resolved).toString())}"><strong>${escapeHTML(candidate.subRouteName)}</strong><span>${escapeHTML(candidate.stopName)}</span></a>`
  }).join('')
  return pageShell('選擇路線｜Mochi Bus', `<main class="setup-page"><header class="topbar"><a class="brand" href="/">MOCHI BUS</a></header><section class="panel"><p class="kicker">同名站牌</p><h1>選擇你搭的支線</h1><div class="choices">${links}</div></section></main>`)
}

function setupScript(): string {
  return `<script type="module">
  import {activeBoardId,busKey,clearLocalData,clearTdxAuth,getTdxAuth,migrateBoards,newBoardId,setActiveBoard,setTdxAuth,syncActiveBoard,tdxHeaders,writeBoards} from '/assets/boards.js';
  const city=document.querySelector('#city'),filter=document.querySelector('#route-filter'),grid=document.querySelector('#route-grid'),categories=document.querySelector('#categories'),message=document.querySelector('#message'),directionStep=document.querySelector('#direction-step'),suggestionStep=document.querySelector('#suggestion-step'),boardList=document.querySelector('#board-list'),pickerPanel=document.querySelector('#picker-panel'),routePicker=document.querySelector('#route-picker'),addBoardButton=document.querySelector('#add-board-button'),closePicker=document.querySelector('#close-picker');
  let routes=[],category='全部',selectedRoute='';
  const boards=()=>migrateBoards();
  function saveBoards(value){writeBoards(value);renderBoards()}
  function params(bus){const p=new URLSearchParams({city:bus.city,route:bus.routeName,stop:bus.stopName,stopUid:bus.stopUid,direction:String(bus.direction)});if(bus.routeUid)p.set('routeUid',bus.routeUid);return p}
  function showInlineUndo(card,board,index,wasActive){card.classList.add('deleted');const text=document.createElement('span');text.textContent='已刪除 '+board.title;const undo=document.createElement('button');undo.className='inline-undo';undo.textContent='復原';card.replaceChildren(text,undo);let timer=setTimeout(()=>{card.classList.add('collapsing');setTimeout(renderBoards,260)},5000);undo.onclick=()=>{clearTimeout(timer);const value=boards();if(!value.some(x=>x.id===board.id))value.splice(Math.min(index,value.length),0,board);writeBoards(value);if(wasActive)setActiveBoard(board.id);card.classList.add('restoring');setTimeout(renderBoards,180)}}
  function renderBoards(){const value=boards(),active=activeBoardId();boardList.replaceChildren();if(!value.length){boardList.innerHTML='<p class="empty">這裡還空著，加一塊常用站牌吧。</p>';return}value.forEach((board,index)=>{const card=document.createElement('article');card.className='board-item';const copy=document.createElement('div');const title=document.createElement('strong');title.textContent=board.title+(board.id===active?' · 封面':'');const detail=document.createElement('span');detail.textContent=board.buses.map(x=>x.routeName).join('、');copy.append(title,detail);const actions=document.createElement('div');actions.className='item-actions';const show=document.createElement('button');show.textContent='顯示在封面';show.disabled=board.id===active;show.onclick=()=>{setActiveBoard(board.id);renderBoards()};const remove=document.createElement('button');remove.textContent='刪除';remove.onclick=()=>{const current=boards(),wasActive=board.id===activeBoardId(),next=current.filter(x=>x.id!==board.id);writeBoards(next);if(wasActive)syncActiveBoard(next);showInlineUndo(card,board,index,wasActive)};actions.append(show,remove);card.append(copy,actions);boardList.append(card)})}
  function openPicker(){pickerPanel.hidden=false;routePicker.hidden=false;directionStep.hidden=true;suggestionStep.hidden=true;pickerPanel.scrollIntoView({behavior:'smooth',block:'start'});if(!routes.length)loadRoutes()}
  function hidePicker(){pickerPanel.hidden=true;selectedRoute=''}
  function backToRoutes(){directionStep.hidden=true;suggestionStep.hidden=true;routePicker.hidden=false;selectedRoute='';routePicker.scrollIntoView({behavior:'smooth',block:'start'})}
  function backToStops(){suggestionStep.hidden=true;directionStep.hidden=false;directionStep.scrollIntoView({behavior:'smooth',block:'start'})}
  function categoryOf(item){if(item.category)return item.category;if((item.routeUid||'').startsWith('THB'))return'公路客運';const name=item.routeName||'',first=name.charAt(0);if(name.includes('台灣好行')||name.includes('觀光'))return'觀光';if(name.includes('幸福')||name.includes('樂活')||name.includes('社區'))return'幸福／社區';if(name.includes('小黃'))return'小黃';if(name.includes('幹線'))return'幹線';if('紅藍綠棕橘黃小F'.includes(first))return'接駁';if('0123456789０１２３４５６７８９'.includes(first))return'數字';return'其他'}
  function renderCategories(){const order=['數字','幹線','接駁','幸福／社區','觀光','小黃','公路客運','其他'],counts={};routes.forEach(item=>{const name=categoryOf(item);counts[name]=(counts[name]||0)+1});const names=['全部',...order.filter(name=>counts[name])];if(!names.includes(category))category='全部';categories.replaceChildren(...names.map(name=>{const b=document.createElement('button');b.className='chip'+(name===category?' active':'');b.textContent=name==='全部'?'全部 '+routes.length:name+' '+counts[name];b.onclick=()=>{category=name;renderCategories();renderRoutes()};return b}))}
  function renderRoutes(){const q=filter.value.trim().toLowerCase();const visible=routes.filter(x=>(category==='全部'||categoryOf(x)===category)&&(!q||x.routeName.toLowerCase().includes(q))).slice(0,120);grid.replaceChildren(...visible.map(item=>{const b=document.createElement('button');b.className='route-choice';b.textContent=item.routeName;b.onclick=()=>chooseRoute(item.routeName);return b}));message.textContent=visible.length?'':'沒有符合的路線'}
  async function loadRoutes(){grid.replaceChildren();message.textContent='正在載入路線…';directionStep.hidden=true;suggestionStep.hidden=true;try{const r=await fetch('/api/v1/routes?schema=2&city='+encodeURIComponent(city.value),{cache:'no-store',headers:tdxHeaders()});const body=await r.json();if(!r.ok)throw Error(body.error);routes=body.routes;message.textContent='共 '+routes.length+' 條路線';renderCategories();renderRoutes()}catch(e){message.textContent=e.message||'路線載入失敗'}}
  async function chooseRoute(routeName){selectedRoute=routeName;message.textContent='正在載入 '+routeName+' 的站牌…';directionStep.hidden=true;suggestionStep.hidden=true;const p=new URLSearchParams({city:city.value,route:routeName});try{const r=await fetch('/api/v1/stops?'+p,{headers:tdxHeaders()}),body=await r.json();if(!r.ok)throw Error(body.error);routePicker.hidden=true;renderDirections(body.groups)}catch(e){message.textContent=e.message||'站牌載入失敗'}}
  function renderDirections(groups){directionStep.replaceChildren();const head=document.createElement('div');head.className='step-head';const back=document.createElement('button');back.className='back-button';back.textContent='← 返回路線';back.onclick=backToRoutes;const title=document.createElement('strong');title.textContent='已選路線 '+selectedRoute;head.append(back,title);directionStep.append(head);groups.forEach(group=>{const card=document.createElement('article');card.className='result-card';const h=document.createElement('h2');h.textContent=group.label;const meta=document.createElement('p');meta.textContent=group.subRouteName;const select=document.createElement('select');group.stops.forEach(stop=>{const o=document.createElement('option');o.value=stop.stopUid;o.textContent=stop.sequence+'. '+stop.stopName;select.append(o)});const b=document.createElement('button');b.className='primary';b.textContent='選這個站牌';b.onclick=()=>{const stop=group.stops.find(x=>x.stopUid===select.value);loadSuggestions(group,stop)};card.append(h,meta,select,b);directionStep.append(card)});directionStep.hidden=false;directionStep.scrollIntoView({behavior:'smooth',block:'start'})}
  function etaRank(label){if(!label)return 9999;if(label.includes('即將'))return 0;const value=Number.parseInt(label,10);return Number.isFinite(value)?value:9998}
  async function loadSuggestions(group,stop){directionStep.hidden=true;suggestionStep.hidden=false;suggestionStep.innerHTML='<p>正在找同站其他公車…</p>';let suggestions=[];try{const p=new URLSearchParams({city:city.value,stop:stop.stopName,stopUid:stop.stopUid});const r=await fetch('/api/v1/stop-routes?'+p,{headers:tdxHeaders()}),body=await r.json();if(r.ok)suggestions=body.buses}catch{}const selected={city:city.value,routeName:selectedRoute,routeUid:group.routeUid,stopName:stop.stopName,stopUid:stop.stopUid,direction:group.direction,directionLabel:group.label},selectedKey=busKey(selected),frequency={};boards().flatMap(board=>board.buses).forEach(bus=>{frequency[bus.routeUid||bus.routeName]=(frequency[bus.routeUid||bus.routeName]||0)+1});const all=[selected,...suggestions].filter((x,i,a)=>a.findIndex(y=>busKey(y)===busKey(x))===i).sort((a,b)=>{const selectedDiff=Number(busKey(b)===selectedKey)-Number(busKey(a)===selectedKey);if(selectedDiff)return selectedDiff;const frequentDiff=(frequency[b.routeUid||b.routeName]||0)-(frequency[a.routeUid||a.routeName]||0);if(frequentDiff)return frequentDiff;const etaDiff=etaRank(a.label)-etaRank(b.label);return etaDiff||a.routeName.localeCompare(b.routeName,'zh-Hant',{numeric:true})}).slice(0,12);renderSuggestions(stop.stopName,all,selectedKey,frequency)}
  function renderSuggestions(stopName,items,selectedKey,frequency){suggestionStep.replaceChildren();const head=document.createElement('div');head.className='step-head';const back=document.createElement('button');back.className='back-button';back.textContent='← 返回方向與站牌';back.onclick=backToStops;const title=document.createElement('strong');title.textContent=stopName;head.append(back,title);const p=document.createElement('p');p.textContent='已依目前選擇、常搭與到站時間排序';const list=document.createElement('div');list.className='suggestion-list';items.forEach((bus,index)=>{const selected=busKey(bus)===selectedKey,isFrequent=(frequency[bus.routeUid||bus.routeName]||0)>0;const row=document.createElement('label');row.className='check-row'+(selected?' selected':'');const check=document.createElement('input');check.type='checkbox';check.checked=selected;check.disabled=selected;check.value=index;const copy=document.createElement('span');copy.className='suggestion-copy';const top=document.createElement('span');top.className='suggestion-main';const route=document.createElement('strong');route.textContent=bus.routeName;const eta=document.createElement('b');eta.textContent=bus.label||'';top.append(route,eta);const direction=document.createElement('small');direction.textContent=bus.directionLabel||'';copy.append(top,direction);const badge=document.createElement('em');badge.textContent=selected?'目前選擇':isFrequent?'常搭':'';row.append(check,copy);if(badge.textContent)row.append(badge);list.append(row)});const save=document.createElement('button');save.className='primary sticky-save';save.textContent='加入常用站牌';save.onclick=()=>{const chosen=[...list.querySelectorAll('input:checked')].map(x=>items[Number(x.value)]);if(!chosen.length)return;const now=new Date().toISOString(),board={version:2,id:newBoardId(),title:stopName,buses:chosen.map(({label,directionLabel,...bus})=>bus),createdAt:now,updatedAt:now};const value=boards();value.push(board);setActiveBoard(board.id);saveBoards(value);location.href='/'};suggestionStep.append(head,p,list,save);suggestionStep.scrollIntoView({behavior:'smooth',block:'start'})}
  const tdxId=document.querySelector('#tdx-client-id'),tdxSecret=document.querySelector('#tdx-client-secret'),tdxSave=document.querySelector('#tdx-save'),tdxRemove=document.querySelector('#tdx-remove'),tdxMessage=document.querySelector('#tdx-message');
  function renderTdx(message){const auth=getTdxAuth();tdxRemove.hidden=!auth;if(auth&&!tdxId.value)tdxId.value=auth.clientId;tdxMessage.textContent=message??(auth?'目前使用你的憑證（'+auth.clientId.slice(0,10)+'…）':'')}
  tdxSave.onclick=async()=>{const clientId=tdxId.value.trim(),clientSecret=tdxSecret.value.trim();if(!clientId||!clientSecret){tdxMessage.textContent='Client ID 與 Client Secret 都要填';return}tdxSave.disabled=true;tdxMessage.textContent='正在跟 TDX 打聲招呼…';try{const r=await fetch('/api/v1/tdx/verify',{cache:'no-store',headers:{'x-tdx-client-id':clientId,'x-tdx-client-secret':clientSecret}});const body=await r.json();if(!r.ok)throw Error(body.error);setTdxAuth({clientId,clientSecret});tdxSecret.value='';renderTdx('憑證有效，之後的即時查詢會走你的額度。')}catch(e){tdxMessage.textContent=e.message||'驗證失敗，稍後再試'}tdxSave.disabled=false};
  tdxRemove.onclick=()=>{clearTdxAuth();tdxId.value='';tdxSecret.value='';renderTdx('已移除，回到共用額度。')};
  renderTdx();
  document.querySelector('#clear-local-button').onclick=()=>{if(confirm('確定清除所有本機資料?常用站牌、封面設定與 TDX 憑證會全部刪除,無法復原。')){clearLocalData();tdxId.value='';tdxSecret.value='';renderBoards();renderTdx()}};
  addBoardButton.onclick=openPicker;closePicker.onclick=hidePicker;filter.addEventListener('input',renderRoutes);city.addEventListener('change',loadRoutes);renderBoards();
  </script>`
}

function renderBusRow(query: ResolvedBusQuery, result?: ETAResult, error?: string): string {
  return `<a class="bus-row" href="/route?${escapeHTML(toBusSearchParams(query).toString())}"><strong class="bus-name">${escapeHTML(query.routeName)}</strong><span class="bus-eta">${escapeHTML(result?.label ?? error ?? '更新中')}</span></a>`
}

export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#f7f2e8"/><rect x="92" y="110" width="328" height="246" rx="80" fill="#df7357"/><rect x="132" y="154" width="248" height="96" rx="30" fill="#fffaf0"/><circle cx="170" cy="356" r="42" fill="#29251f"/><circle cx="342" cy="356" r="42" fill="#29251f"/><path d="M170 292h172" stroke="#29251f" stroke-width="24" stroke-linecap="round"/></svg>`

function pageShell(title: string, body: string, script = '', description = '一眼查看常用站牌的公車到站時間'): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f2e8"><meta name="description" content="${escapeHTML(description)}"><meta property="og:title" content="${escapeHTML(title)}"><meta property="og:description" content="${escapeHTML(description)}"><meta property="og:site_name" content="Mochi Bus"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icon.svg"><title>${escapeHTML(title)}</title><style>${styles}${enhancementStyles}</style></head><body>${body}${script}</body></html>`
}

const styles = `:root{color-scheme:light;font-family:ui-rounded,"SF Pro Rounded","PingFang TC",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#f7f2e8;color:#29251f}a{color:inherit}.eta-page,.setup-page,.route-page{width:min(100%,720px);min-height:100svh;margin:0 auto;padding:max(26px,env(safe-area-inset-top)) 22px max(28px,env(safe-area-inset-bottom))}.eta-page{display:flex;flex-direction:column}.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px}.brand{text-decoration:none;font-size:15px;font-weight:850;letter-spacing:.04em}.icon-link{padding:9px 12px;border:1px solid #d8d0c2;border-radius:999px;text-decoration:none;font-size:14px;font-weight:750}.cover{flex:1;display:grid;align-content:center;padding:52px 0 36px}.eyebrow{margin:0 0 18px;color:#716a60;font-size:18px;font-weight:800}.bus-list{display:grid}.bus-row{display:grid;grid-template-columns:minmax(80px,1fr) auto;align-items:baseline;gap:18px;padding:17px 0;border-bottom:1px solid #ddd3c4;text-decoration:none}.bus-name{font-size:clamp(30px,10vw,54px);letter-spacing:-.04em}.bus-eta{font-size:clamp(27px,9vw,50px);font-weight:900;letter-spacing:-.05em;font-variant-numeric:tabular-nums;white-space:nowrap}.notice{min-height:22px;color:#9b4b35;font-size:14px;font-weight:700}.eta-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#777066;font-size:13px}.primary,button{appearance:none;border:0;border-radius:12px;padding:12px 17px;background:#df7357;color:white;font:inherit;font-weight:800;cursor:pointer}.primary.compact{border-radius:999px}.primary:disabled,button:disabled{opacity:.55;cursor:wait}.setup-page{display:flex;flex-direction:column;gap:22px}.panel{margin-top:18px;padding:24px;border:1px solid #ded6c9;border-radius:24px;background:rgba(255,250,240,.62)}.panel h1{margin:8px 0 24px;font-size:clamp(38px,10vw,62px);line-height:1.02;letter-spacing:-.05em}.kicker{margin:0;color:#a44f39;font-size:13px;font-weight:850;letter-spacing:.08em}.board-list,.step,.choices{display:grid;gap:12px}.board-item,.result-card,.choice{padding:16px;border:1px solid #ded6c9;border-radius:17px;background:#fffaf0}.board-item{display:flex;align-items:center;justify-content:space-between;gap:15px}.board-item>div:first-child{display:grid;gap:5px}.board-item span,.result-card p,.choice span{color:#777066;font-size:13px}.item-actions{display:flex;gap:7px}.item-actions button{background:transparent;color:#a44f39;padding:6px;font-size:13px}.flow-steps{display:flex;gap:7px;margin:14px 0 18px;overflow:auto}.flow-steps span{flex:none;padding:7px 10px;border-radius:999px;background:#e9e1d5;color:#777066;font-size:12px;font-weight:800}.flow-steps span.active{background:#29251f;color:#fffaf0}.flow-steps span.done{background:#df735733;color:#a44f39}.picker-head{display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:14px}.picker-head label{display:grid;gap:7px;color:#716a60;font-size:13px;font-weight:750}select,input{width:100%;border:1px solid #d8d0c2;border-radius:12px;background:#fffaf0;color:#29251f;padding:11px 12px;font:inherit}.category-list{display:flex;gap:7px;overflow:auto;padding:4px 0 12px}.chip{flex:none;border:1px solid #d8d0c2;background:transparent;color:#716a60;border-radius:999px;padding:7px 12px;font-size:13px}.chip.active{background:#29251f;color:#fffaf0}.form-message{color:#777066;font-size:13px}.route-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:8px;max-height:330px;overflow:auto}.route-choice{background:#fffaf0;color:#29251f;border:1px solid #ded6c9;padding:11px 8px}.step{margin-top:24px;padding-top:20px;border-top:1px solid #ded6c9}.step-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.back-button{padding:7px 0;background:transparent;color:#a44f39}.result-card{display:grid;gap:12px}.result-card h2{margin:0;font-size:17px}.result-card p{margin:0}.suggestion-list{display:grid;gap:8px}.check-row{display:flex;align-items:center;gap:10px;padding:11px;border:1px solid #ded6c9;border-radius:12px}.check-row.selected{border-color:#df7357;background:#df73570d}.check-row input{width:auto}.check-row span{flex:1}.check-row em{flex:none;color:#a44f39;font-size:11px;font-style:normal;font-weight:850}.choice{display:grid;gap:5px;text-decoration:none}.empty{color:#777066}.undo-toast{position:fixed;left:50%;bottom:max(24px,env(safe-area-inset-bottom));z-index:10;width:min(calc(100% - 32px),520px);transform:translateX(-50%);display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 16px;border-radius:15px;background:#29251f;color:#fffaf0;box-shadow:0 12px 40px #0004;font-weight:750}.undo-toast[hidden]{display:none}.undo-toast button{padding:7px 9px;background:transparent;color:#f09b80}.route-page{padding-bottom:60px}.route-head{padding:48px 0 28px}.route-badge{display:inline-block;padding:9px 14px;border-radius:999px;background:#29251f;color:#fffaf0;font-weight:850}.route-head h1{margin:18px 0 8px;font-size:clamp(28px,8vw,48px);line-height:1.08;letter-spacing:-.04em}.route-head p{color:#777066}.route-timeline{list-style:none;margin:0;padding:0}.route-stop{position:relative;display:grid;grid-template-columns:24px 1fr auto;gap:12px;min-height:58px}.route-stop:before{content:"";position:absolute;left:8px;top:18px;bottom:-4px;width:2px;background:#d8d0c2}.route-stop:last-child:before{display:none}.dot{position:relative;z-index:1;width:18px;height:18px;border:4px solid #f7f2e8;border-radius:50%;background:#aaa197}.route-stop.selected .dot{background:#df7357;box-shadow:0 0 0 3px #df735744}.route-stop div{display:flex;gap:8px;align-items:flex-start}.route-stop em{color:#df7357;font-size:12px;font-style:normal;font-weight:800}.route-stop>span:last-child{color:#777066;font-size:14px;font-weight:700}@media(max-width:520px){.picker-head{grid-template-columns:1fr}.board-item{align-items:flex-start;flex-direction:column}.bus-row{grid-template-columns:1fr auto}.item-actions{flex-wrap:wrap}}@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background:#211f1b;color:#f8f0e3}.panel{border-color:#464139;background:#2a2722}.board-item,.result-card,.choice,input,select,.route-choice,.check-row{border-color:#4d473e;background:#302c26;color:#f8f0e3}.icon-link,.chip{border-color:#4d473e}.chip.active,.route-badge,.flow-steps span.active{background:#f8f0e3;color:#211f1b}.bus-row,.step{border-color:#4d473e}.eyebrow,.eta-footer,.board-item span,.result-card p,.choice span,.route-head p,.route-stop>span:last-child{color:#aaa197}.route-stop:before{background:#4d473e}.route-stop .dot{border-color:#211f1b}.notice{color:#f09b80}}`

const enhancementStyles = `.onboard-sign{position:relative;overflow:hidden;margin:0 0 26px;padding:12px 0;border-radius:9px;background:#211e19;box-shadow:inset 0 0 0 1px #3a3426,inset 0 5px 16px #000c,0 3px 14px #2922141f}.onboard-sign::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,#0000 0 2px,#0005 2px 3px),repeating-linear-gradient(0deg,#0000 0 2px,#0005 2px 3px);pointer-events:none}.onboard-sign-track{display:flex;gap:72px;width:max-content;animation:onboard-sign-scroll 18s linear infinite}.onboard-sign:hover .onboard-sign-track{animation-play-state:paused}.onboard-sign-track span{white-space:nowrap;color:#ffb23e;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:800;letter-spacing:.24em;text-transform:uppercase;text-shadow:0 0 8px #ffb23e99,0 0 2px #ffb23e}@keyframes onboard-sign-scroll{from{transform:translateX(0)}to{transform:translateX(calc(-50% - 36px))}}@media(prefers-reduced-motion:reduce){.onboard-sign-track{width:100%;justify-content:center;animation:none}.onboard-sign-track span+span{display:none}.onboard-sign-track span{padding:0 14px;white-space:normal;text-align:center;letter-spacing:.12em;line-height:1.7}}.onboard{display:grid;gap:16px;margin-top:30px}.onboard[hidden]{display:none}.onboard p{margin:0 2px;color:#716a60;font-size:14.5px;font-weight:650;line-height:1.8;letter-spacing:.01em}.onboard-map{display:flex;align-items:center;justify-content:space-between;padding:19px 22px;border-radius:18px;background:#29251f;color:#fffaf0;font-size:19px;font-weight:850;letter-spacing:.2em;text-decoration:none}.onboard-map span{font-size:21px;letter-spacing:0;transition:transform .18s ease}.onboard-map:hover span,.onboard-map:focus-visible span{transform:translateX(5px)}.add-board-button{width:100%;margin-top:14px;background:transparent;color:#a44f39;border:1px dashed #d0b7a9}.clear-local-button{width:100%;padding:8px;background:transparent;color:#9b4b35;font-size:13px;border:1px solid #d8d0c2;border-radius:12px}.advanced-panel{margin-top:22px;border-top:1px solid #ded6c9}.advanced-panel>summary{padding:13px 0 5px;color:#777066;font-size:13px;font-weight:750;cursor:pointer;list-style:none}.advanced-panel>summary::-webkit-details-marker{display:none}.advanced-panel>summary::before{content:'▸ '}.advanced-panel[open]>summary::before{content:'▾ '}.advanced-section{display:grid;gap:10px;padding:14px 0}.advanced-section+.advanced-section{border-top:1px solid #e7dfd2}.advanced-section strong{font-size:14px}.advanced-section p{margin:0;color:#777066;font-size:13px;line-height:1.6}.advanced-section a{color:#a44f39}.advanced-actions{display:flex;gap:8px}.advanced-actions button{flex:1}.quiet-danger{background:transparent;color:#9b4b35;border:1px solid #d8d0c2}.glossary summary{padding:2px 0;color:#a44f39;font-size:13px;font-weight:750;cursor:pointer;list-style:none}.glossary summary::-webkit-details-marker{display:none}.glossary summary::before{content:'▸ '}.glossary[open] summary::before{content:'▾ '}.glossary-list{display:grid;gap:9px;margin:14px 0 12px}.glossary-list div{display:grid;grid-template-columns:108px 1fr;gap:10px;font-size:13px}.glossary-list b{color:#29251f;font-variant-numeric:tabular-nums;line-height:1.55}.glossary-list span{color:#777066;line-height:1.55}.glossary-tip{margin:0 0 10px}.glossary-thanks{margin:2px 0 0;color:#9a9184;font-size:12px;line-height:1.6}.picker-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.board-item{max-height:110px;overflow:hidden;transition:max-height .26s ease,opacity .2s ease,transform .2s ease,background-color .2s ease}.board-item.deleted{justify-content:space-between;background:#29251f;color:#fffaf0}.board-item.deleted span{color:#fffaf0}.board-item.collapsing{max-height:0;min-height:0;padding-top:0;padding-bottom:0;margin:0;opacity:0;transform:scale(.97)}.board-item.restoring{background:#df735733;transform:scale(1.01)}.inline-undo{padding:7px 10px;background:transparent;color:#f09b80}.suggestion-copy{display:grid;gap:3px;min-width:0}.suggestion-main{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.suggestion-main strong{font-size:17px}.suggestion-main b{white-space:nowrap;font-size:15px}.suggestion-copy small{overflow:hidden;color:#777066;text-overflow:ellipsis;white-space:nowrap}.sticky-save{position:sticky;bottom:max(12px,env(safe-area-inset-bottom));z-index:3;width:100%;box-shadow:0 10px 28px #0003}@media(prefers-color-scheme:dark){.onboard p{color:#aaa197}.onboard-map{background:#f8f0e3;color:#211f1b}.advanced-panel{border-color:#4d473e}.advanced-section+.advanced-section{border-color:#3a362f}.advanced-section p{color:#aaa197}.clear-local-button,.quiet-danger{border-color:#4d473e}.glossary summary{color:#f09b80}.glossary-list b{color:#f8f0e3}.glossary-list span{color:#aaa197}.glossary-thanks{color:#847d70}.add-board-button{border-color:#694d43}.clear-local-button{color:#f09b80}.board-item.deleted{background:#f8f0e3;color:#211f1b}.board-item.deleted span{color:#211f1b}.suggestion-copy small{color:#aaa197}}`

function escapeHTML(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;') }
function safeJSON(value: unknown): string { return JSON.stringify(value).replaceAll('<', '\\u003c') }
function formatTaipeiTime(value: string): string { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) }
