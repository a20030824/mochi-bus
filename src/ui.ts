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

  return pageShell('Mochi Bus', `
  <main class="eta-page">
    <header class="topbar">
      <a class="brand" href="/">MOCHI BUS</a>
      <nav class="top-actions" aria-label="主要功能" style="display:flex;align-items:center;gap:8px"><a class="icon-link" style="border-color:#a9b7ad;color:#3f594c" href="/map">地圖</a><a class="icon-link" href="/setup">我的公車</a></nav>
    </header>
    <section class="cover" aria-live="polite">
      <p class="eyebrow" id="board-title">${escapeHTML(query.stopName)}</p>
      <div class="bus-list" id="bus-list">${renderBusRow(query, result, error)}</div>
      <p class="notice" id="notice">${escapeHTML(result?.stale ? '資料可能延遲，請留意站牌資訊' : error ?? '')}</p>
    </section>
    <footer class="eta-footer">
      <span id="updated">${result ? `資料 ${formatTaipeiTime(result.dataTime ?? result.fetchedAt)}` : '尚未更新'}</span>
      <button class="primary compact" id="refresh" type="button">重新整理</button>
    </footer>
  </main>`, `
  <script>
    const BOARDS_KEY = 'mochi.bus.boards.v2';
    const ACTIVE_KEY = 'mochi.bus.activeBoard.v2';
    const OLD_PRESETS_KEY = 'mochi.bus.presets.v1';
    const OLD_ACTIVE_KEY = 'mochi.bus.activePreset.v1';
    const ACTIVE_CITY_KEY = 'mochi.bus.activeCity.v1';
    const initialBoard = ${safeJSON(initialBoard)};
    const useLocalBoard = ${useLocalBoard};
    let currentBoard = initialBoard;
    const listNode = document.querySelector('#bus-list');
    const titleNode = document.querySelector('#board-title');
    const noticeNode = document.querySelector('#notice');
    const updatedNode = document.querySelector('#updated');
    const refreshButton = document.querySelector('#refresh');
    const topActionLinks = document.querySelectorAll('.top-actions a');
    const mapLink = topActionLinks[0];
    mapLink.removeAttribute('style');
    if (topActionLinks[1]) topActionLinks[1].remove();

    function readJSON(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
      catch { return fallback; }
    }

    function migrateBoards() {
      const existing = readJSON(BOARDS_KEY, []);
      // v2 key 存在時，空陣列代表使用者真的刪光了，不能再次匯入舊資料。
      if (localStorage.getItem(BOARDS_KEY) !== null) return Array.isArray(existing) ? existing : [];
      const old = readJSON(OLD_PRESETS_KEY, []);
      const now = new Date().toISOString();
      const migrated = Array.isArray(old) ? old.filter(item => item?.stopUid).map(item => ({
        version: 2, id: item.id, title: item.stopName || item.label || '常用站牌', buses: [{
          city: item.city, routeName: item.routeName, routeUid: item.routeUid,
          stopName: item.stopName, stopUid: item.stopUid, direction: item.direction
        }], createdAt: item.createdAt || now, updatedAt: now
      })) : [];
      const boards = migrated.length ? migrated : [initialBoard];
      localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
      const oldActive = localStorage.getItem(OLD_ACTIVE_KEY);
      localStorage.setItem(ACTIVE_KEY, boards.some(item => item.id === oldActive) ? oldActive : boards[0].id);
      return boards;
    }

    function paramsFor(bus) {
      const params = new URLSearchParams({ city: bus.city || currentBoard.city, route: bus.routeName, direction: String(bus.direction) });
      if (bus.stopName) params.set('stop', bus.stopName);
      if (bus.stopUid) params.set('stopUid', bus.stopUid);
      if (bus.routeUid) params.set('routeUid', bus.routeUid);
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
      link.append(routeCopy, eta);
      return link;
    }

    async function fillDirectionLabel(bus) {
      if (bus.directionLabel) return;
      try {
        const params = new URLSearchParams({ city: bus.city, route: bus.routeName });
        const response = await fetch('/api/v1/stops?' + params);
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
          placeRoutesPromise ||= fetch('/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/routes?city=' + encodeURIComponent(city))
            .then(response => response.ok ? response.json() : Promise.reject());
          const body = await placeRoutesPromise;
          const candidates = (body.routes || []).filter(route =>
            route.routeName === bus.routeName
            && route.direction === bus.direction
            && (!bus.routeUid || route.routeUid === bus.routeUid));
          const match = candidates.find(route => !bus.directionLabel || route.label === bus.directionLabel) || candidates[0];
          if (match) {
            bus.city = city;
            bus.routeUid = match.routeUid;
            bus.stopName = match.stopName;
            bus.stopUid = match.stopUid;
            bus.directionLabel = match.label;
            return true;
          }
        }
        const params = new URLSearchParams({ city, route: bus.routeName });
        const response = await fetch('/api/v1/stops?' + params);
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
        bus.stopName = matches[0].stop.stopName;
        bus.stopUid = matches[0].stop.stopUid;
        bus.directionLabel = matches[0].group.label;
        return true;
      } catch { return false; }
    }

    async function refreshBoard() {
      refreshButton.disabled = true;
      refreshButton.textContent = '更新中';
      noticeNode.textContent = '';
      const responses = await Promise.all(currentBoard.buses.map(async bus => {
        const repaired = await repairBusFromPlace(bus);
        if (!repaired) return { bus, failed: true };
        await fillDirectionLabel(bus);
        try {
          const response = await fetch('/api/v1/eta?' + paramsFor(bus), { cache: 'no-store' });
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
      localStorage.setItem(BOARDS_KEY, JSON.stringify(migrateBoards().map(board => board.id === currentBoard.id ? currentBoard : board)));
      const fresh = responses.filter(item => item.data).map(item => item.data);
      if (fresh.some(item => item.stale)) noticeNode.textContent = '部分資料可能延遲，請留意站牌資訊';
      updatedNode.textContent = fresh[0] ? '資料 ' + new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(fresh[0].dataTime || fresh[0].fetchedAt)) : '暫時無法更新';
      refreshButton.disabled = false;
      refreshButton.textContent = '重新整理';
    }

    if (useLocalBoard) {
      const storedBoards = migrateBoards();
      const boards = storedBoards.filter(board => !(board.placeId && board.buses?.length > 1 && board.buses.every(bus => !bus.directionLabel)));
      if (boards.length !== storedBoards.length) {
        localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
        if (!boards.some(board => board.id === localStorage.getItem(ACTIVE_KEY))) {
          if (boards[0]) localStorage.setItem(ACTIVE_KEY, boards[0].id);
          else localStorage.removeItem(ACTIVE_KEY);
        }
      }
      if (!boards.length) boards.push(initialBoard);
      const activeId = localStorage.getItem(ACTIVE_KEY) || boards[0].id;
      currentBoard = boards.find(item => item.id === activeId) || boards[0];
      titleNode.textContent = currentBoard.title;
      const firstBus = currentBoard.buses[0];
      const city = currentBoard.city || firstBus?.city;
      if (city) {
        localStorage.setItem(ACTIVE_CITY_KEY, city);
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
    setInterval(refreshBoard, 30_000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  </script>`)
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
  return pageShell(`${query.routeName} 路線｜Mochi Bus`, `<main class="route-page"><header class="topbar"><a class="icon-link" href="javascript:history.back()">返回</a><a class="brand" href="/">MOCHI BUS</a></header><section class="route-head"><span class="route-badge">${escapeHTML(query.routeName)}</span><h1>${escapeHTML(detail.label)}</h1><p>你選的站牌已標示</p></section><ol class="route-timeline">${stops}</ol></main>`)
}

export function renderAmbiguousPage(query: BusQuery, candidates: RouteStop[]): string {
  const links = candidates.map((candidate) => {
    const resolved: ResolvedBusQuery = { ...query, routeUid: query.routeUid ?? candidate.routeUid, stopName: candidate.stopName, stopUid: candidate.stopUid }
    return `<a class="choice" href="/bus?${escapeHTML(toBusSearchParams(resolved).toString())}"><strong>${escapeHTML(candidate.subRouteName)}</strong><span>${escapeHTML(candidate.stopName)}</span></a>`
  }).join('')
  return pageShell('選擇路線｜Mochi Bus', `<main class="setup-page"><header class="topbar"><a class="brand" href="/">MOCHI BUS</a></header><section class="panel"><p class="kicker">同名站牌</p><h1>選擇你搭的支線</h1><div class="choices">${links}</div></section></main>`)
}

function setupScript(): string {
  return `<script>
  const BOARDS_KEY='mochi.bus.boards.v2',ACTIVE_KEY='mochi.bus.activeBoard.v2',OLD_KEY='mochi.bus.presets.v1';
  const city=document.querySelector('#city'),filter=document.querySelector('#route-filter'),grid=document.querySelector('#route-grid'),categories=document.querySelector('#categories'),message=document.querySelector('#message'),directionStep=document.querySelector('#direction-step'),suggestionStep=document.querySelector('#suggestion-step'),boardList=document.querySelector('#board-list'),pickerPanel=document.querySelector('#picker-panel'),routePicker=document.querySelector('#route-picker'),addBoardButton=document.querySelector('#add-board-button'),closePicker=document.querySelector('#close-picker');
  let routes=[],category='全部',selectedRoute='';
  const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))}catch{return fallback}};
  function boards(){let value=read(BOARDS_KEY,[]);if(localStorage.getItem(BOARDS_KEY)!==null)return Array.isArray(value)?value:[];const old=read(OLD_KEY,[]),now=new Date().toISOString();value=old.filter(x=>x?.stopUid).map(x=>({version:2,id:x.id,title:x.stopName,buses:[{city:x.city,routeName:x.routeName,routeUid:x.routeUid,stopName:x.stopName,stopUid:x.stopUid,direction:x.direction}],createdAt:x.createdAt||now,updatedAt:now}));localStorage.setItem(BOARDS_KEY,JSON.stringify(value));if(value.length)localStorage.setItem(ACTIVE_KEY,value[0].id);return value}
  function saveBoards(value){localStorage.setItem(BOARDS_KEY,JSON.stringify(value));renderBoards()}
  function params(bus){const p=new URLSearchParams({city:bus.city,route:bus.routeName,stop:bus.stopName,stopUid:bus.stopUid,direction:String(bus.direction)});if(bus.routeUid)p.set('routeUid',bus.routeUid);return p}
  function showInlineUndo(card,board,index,wasActive){card.classList.add('deleted');const text=document.createElement('span');text.textContent='已刪除 '+board.title;const undo=document.createElement('button');undo.className='inline-undo';undo.textContent='復原';card.replaceChildren(text,undo);let timer=setTimeout(()=>{card.classList.add('collapsing');setTimeout(renderBoards,260)},5000);undo.onclick=()=>{clearTimeout(timer);const value=boards();if(!value.some(x=>x.id===board.id))value.splice(Math.min(index,value.length),0,board);localStorage.setItem(BOARDS_KEY,JSON.stringify(value));if(wasActive)localStorage.setItem(ACTIVE_KEY,board.id);card.classList.add('restoring');setTimeout(renderBoards,180)}}
  function renderBoards(){const value=boards(),active=localStorage.getItem(ACTIVE_KEY);boardList.replaceChildren();if(!value.length){boardList.innerHTML='<p class="empty">還沒有常用站牌。</p>';return}value.forEach((board,index)=>{const card=document.createElement('article');card.className='board-item';const copy=document.createElement('div');const title=document.createElement('strong');title.textContent=board.title+(board.id===active?' · 封面':'');const detail=document.createElement('span');detail.textContent=board.buses.map(x=>x.routeName).join('、');copy.append(title,detail);const actions=document.createElement('div');actions.className='item-actions';const show=document.createElement('button');show.textContent='顯示在封面';show.disabled=board.id===active;show.onclick=()=>{localStorage.setItem(ACTIVE_KEY,board.id);renderBoards()};const remove=document.createElement('button');remove.textContent='刪除';remove.onclick=()=>{const current=boards(),wasActive=board.id===localStorage.getItem(ACTIVE_KEY),next=current.filter(x=>x.id!==board.id);if(wasActive){if(next[0])localStorage.setItem(ACTIVE_KEY,next[0].id);else localStorage.removeItem(ACTIVE_KEY)}localStorage.setItem(BOARDS_KEY,JSON.stringify(next));showInlineUndo(card,board,index,wasActive)};actions.append(show,remove);card.append(copy,actions);boardList.append(card)})}
  function openPicker(){pickerPanel.hidden=false;routePicker.hidden=false;directionStep.hidden=true;suggestionStep.hidden=true;pickerPanel.scrollIntoView({behavior:'smooth',block:'start'});if(!routes.length)loadRoutes()}
  function hidePicker(){pickerPanel.hidden=true;selectedRoute=''}
  function backToRoutes(){directionStep.hidden=true;suggestionStep.hidden=true;routePicker.hidden=false;selectedRoute='';routePicker.scrollIntoView({behavior:'smooth',block:'start'})}
  function backToStops(){suggestionStep.hidden=true;directionStep.hidden=false;directionStep.scrollIntoView({behavior:'smooth',block:'start'})}
  function categoryOf(item){if(item.category)return item.category;const name=item.routeName||'',first=name.charAt(0);if(name.includes('台灣好行')||name.includes('觀光'))return'觀光';if(name.includes('幸福')||name.includes('樂活')||name.includes('社區'))return'幸福／社區';if(name.includes('小黃'))return'小黃';if(name.includes('幹線'))return'幹線';if('紅藍綠棕橘黃小F'.includes(first))return'接駁';if('0123456789０１２３４５６７８９'.includes(first))return'數字';return'其他'}
  function renderCategories(){const order=['數字','幹線','接駁','幸福／社區','觀光','小黃','其他'],counts={};routes.forEach(item=>{const name=categoryOf(item);counts[name]=(counts[name]||0)+1});const names=['全部',...order.filter(name=>counts[name])];if(!names.includes(category))category='全部';categories.replaceChildren(...names.map(name=>{const b=document.createElement('button');b.className='chip'+(name===category?' active':'');b.textContent=name==='全部'?'全部 '+routes.length:name+' '+counts[name];b.onclick=()=>{category=name;renderCategories();renderRoutes()};return b}))}
  function renderRoutes(){const q=filter.value.trim().toLowerCase();const visible=routes.filter(x=>(category==='全部'||categoryOf(x)===category)&&(!q||x.routeName.toLowerCase().includes(q))).slice(0,120);grid.replaceChildren(...visible.map(item=>{const b=document.createElement('button');b.className='route-choice';b.textContent=item.routeName;b.onclick=()=>chooseRoute(item.routeName);return b}));message.textContent=visible.length?'':'沒有符合的路線'}
  async function loadRoutes(){grid.replaceChildren();message.textContent='正在載入路線…';directionStep.hidden=true;suggestionStep.hidden=true;try{const r=await fetch('/api/v1/routes?schema=2&city='+encodeURIComponent(city.value),{cache:'no-store'});const body=await r.json();if(!r.ok)throw Error(body.error);routes=body.routes;message.textContent='共 '+routes.length+' 條路線';renderCategories();renderRoutes()}catch(e){message.textContent=e.message||'路線載入失敗'}}
  async function chooseRoute(routeName){selectedRoute=routeName;message.textContent='正在載入 '+routeName+' 的站牌…';directionStep.hidden=true;suggestionStep.hidden=true;const p=new URLSearchParams({city:city.value,route:routeName});try{const r=await fetch('/api/v1/stops?'+p),body=await r.json();if(!r.ok)throw Error(body.error);routePicker.hidden=true;renderDirections(body.groups)}catch(e){message.textContent=e.message||'站牌載入失敗'}}
  function renderDirections(groups){directionStep.replaceChildren();const head=document.createElement('div');head.className='step-head';const back=document.createElement('button');back.className='back-button';back.textContent='← 返回路線';back.onclick=backToRoutes;const title=document.createElement('strong');title.textContent='已選路線 '+selectedRoute;head.append(back,title);directionStep.append(head);groups.forEach(group=>{const card=document.createElement('article');card.className='result-card';const h=document.createElement('h2');h.textContent=group.label;const meta=document.createElement('p');meta.textContent=group.subRouteName;const select=document.createElement('select');group.stops.forEach(stop=>{const o=document.createElement('option');o.value=stop.stopUid;o.textContent=stop.sequence+'. '+stop.stopName;select.append(o)});const b=document.createElement('button');b.className='primary';b.textContent='選這個站牌';b.onclick=()=>{const stop=group.stops.find(x=>x.stopUid===select.value);loadSuggestions(group,stop)};card.append(h,meta,select,b);directionStep.append(card)});directionStep.hidden=false;directionStep.scrollIntoView({behavior:'smooth',block:'start'})}
  function busKey(bus){return (bus.routeUid||bus.routeName)+':'+bus.stopUid+':'+bus.direction}
  function etaRank(label){if(!label)return 9999;if(label.includes('即將'))return 0;const value=Number.parseInt(label,10);return Number.isFinite(value)?value:9998}
  async function loadSuggestions(group,stop){directionStep.hidden=true;suggestionStep.hidden=false;suggestionStep.innerHTML='<p>正在找同站其他公車…</p>';let suggestions=[];try{const p=new URLSearchParams({city:city.value,stop:stop.stopName,stopUid:stop.stopUid});const r=await fetch('/api/v1/stop-routes?'+p),body=await r.json();if(r.ok)suggestions=body.buses}catch{}const selected={city:city.value,routeName:selectedRoute,routeUid:group.routeUid,stopName:stop.stopName,stopUid:stop.stopUid,direction:group.direction,directionLabel:group.label},selectedKey=busKey(selected),frequency={};boards().flatMap(board=>board.buses).forEach(bus=>{frequency[bus.routeUid||bus.routeName]=(frequency[bus.routeUid||bus.routeName]||0)+1});const all=[selected,...suggestions].filter((x,i,a)=>a.findIndex(y=>busKey(y)===busKey(x))===i).sort((a,b)=>{const selectedDiff=Number(busKey(b)===selectedKey)-Number(busKey(a)===selectedKey);if(selectedDiff)return selectedDiff;const frequentDiff=(frequency[b.routeUid||b.routeName]||0)-(frequency[a.routeUid||a.routeName]||0);if(frequentDiff)return frequentDiff;const etaDiff=etaRank(a.label)-etaRank(b.label);return etaDiff||a.routeName.localeCompare(b.routeName,'zh-Hant',{numeric:true})}).slice(0,12);renderSuggestions(stop.stopName,all,selectedKey,frequency)}
  function renderSuggestions(stopName,items,selectedKey,frequency){suggestionStep.replaceChildren();const head=document.createElement('div');head.className='step-head';const back=document.createElement('button');back.className='back-button';back.textContent='← 返回方向與站牌';back.onclick=backToStops;const title=document.createElement('strong');title.textContent=stopName;head.append(back,title);const p=document.createElement('p');p.textContent='已依目前選擇、常搭與到站時間排序';const list=document.createElement('div');list.className='suggestion-list';items.forEach((bus,index)=>{const selected=busKey(bus)===selectedKey,isFrequent=(frequency[bus.routeUid||bus.routeName]||0)>0;const row=document.createElement('label');row.className='check-row'+(selected?' selected':'');const check=document.createElement('input');check.type='checkbox';check.checked=selected;check.disabled=selected;check.value=index;const copy=document.createElement('span');copy.className='suggestion-copy';const top=document.createElement('span');top.className='suggestion-main';const route=document.createElement('strong');route.textContent=bus.routeName;const eta=document.createElement('b');eta.textContent=bus.label||'';top.append(route,eta);const direction=document.createElement('small');direction.textContent=bus.directionLabel||'';copy.append(top,direction);const badge=document.createElement('em');badge.textContent=selected?'目前選擇':isFrequent?'常搭':'';row.append(check,copy);if(badge.textContent)row.append(badge);list.append(row)});const save=document.createElement('button');save.className='primary sticky-save';save.textContent='加入常用站牌';save.onclick=()=>{const chosen=[...list.querySelectorAll('input:checked')].map(x=>items[Number(x.value)]);if(!chosen.length)return;const now=new Date().toISOString(),board={version:2,id:crypto.randomUUID?.()||String(Date.now()),title:stopName,buses:chosen.map(({label,directionLabel,...bus})=>bus),createdAt:now,updatedAt:now};const value=boards();value.push(board);localStorage.setItem(ACTIVE_KEY,board.id);saveBoards(value);location.href='/'};suggestionStep.append(head,p,list,save);suggestionStep.scrollIntoView({behavior:'smooth',block:'start'})}
  addBoardButton.onclick=openPicker;closePicker.onclick=hidePicker;filter.addEventListener('input',renderRoutes);city.addEventListener('change',loadRoutes);renderBoards();
  </script>`
}

function renderBusRow(query: ResolvedBusQuery, result?: ETAResult, error?: string): string {
  return `<a class="bus-row" href="/route?${escapeHTML(toBusSearchParams(query).toString())}"><strong class="bus-name">${escapeHTML(query.routeName)}</strong><span class="bus-eta">${escapeHTML(result?.label ?? error ?? '更新中')}</span></a>`
}

export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#f7f2e8"/><rect x="92" y="110" width="328" height="246" rx="80" fill="#df7357"/><rect x="132" y="154" width="248" height="96" rx="30" fill="#fffaf0"/><circle cx="170" cy="356" r="42" fill="#29251f"/><circle cx="342" cy="356" r="42" fill="#29251f"/><path d="M170 292h172" stroke="#29251f" stroke-width="24" stroke-linecap="round"/></svg>`

function pageShell(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f2e8"><meta name="description" content="一眼查看常用站牌的公車到站時間"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icon.svg"><title>${escapeHTML(title)}</title><style>${styles}${enhancementStyles}</style></head><body>${body}${script}</body></html>`
}

const styles = `:root{color-scheme:light;font-family:ui-rounded,"SF Pro Rounded","PingFang TC",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#f7f2e8;color:#29251f}a{color:inherit}.eta-page,.setup-page,.route-page{width:min(100%,720px);min-height:100svh;margin:0 auto;padding:max(26px,env(safe-area-inset-top)) 22px max(28px,env(safe-area-inset-bottom))}.eta-page{display:flex;flex-direction:column}.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px}.brand{text-decoration:none;font-size:15px;font-weight:850;letter-spacing:.04em}.icon-link{padding:9px 12px;border:1px solid #d8d0c2;border-radius:999px;text-decoration:none;font-size:14px;font-weight:750}.cover{flex:1;display:grid;align-content:center;padding:52px 0 36px}.eyebrow{margin:0 0 18px;color:#716a60;font-size:18px;font-weight:800}.bus-list{display:grid}.bus-row{display:grid;grid-template-columns:minmax(80px,1fr) auto;align-items:baseline;gap:18px;padding:17px 0;border-bottom:1px solid #ddd3c4;text-decoration:none}.bus-name{font-size:clamp(30px,10vw,54px);letter-spacing:-.04em}.bus-eta{font-size:clamp(27px,9vw,50px);font-weight:900;letter-spacing:-.05em}.notice{min-height:22px;color:#9b4b35;font-size:14px;font-weight:700}.eta-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#777066;font-size:13px}.primary,button{appearance:none;border:0;border-radius:12px;padding:12px 17px;background:#df7357;color:white;font:inherit;font-weight:800;cursor:pointer}.primary.compact{border-radius:999px}.primary:disabled,button:disabled{opacity:.55;cursor:wait}.setup-page{display:flex;flex-direction:column;gap:22px}.panel{margin-top:18px;padding:24px;border:1px solid #ded6c9;border-radius:24px;background:rgba(255,250,240,.62)}.panel h1{margin:8px 0 24px;font-size:clamp(38px,10vw,62px);line-height:1.02;letter-spacing:-.05em}.kicker{margin:0;color:#a44f39;font-size:13px;font-weight:850;letter-spacing:.08em}.board-list,.step,.choices{display:grid;gap:12px}.board-item,.result-card,.choice{padding:16px;border:1px solid #ded6c9;border-radius:17px;background:#fffaf0}.board-item{display:flex;align-items:center;justify-content:space-between;gap:15px}.board-item>div:first-child{display:grid;gap:5px}.board-item span,.result-card p,.choice span{color:#777066;font-size:13px}.item-actions{display:flex;gap:7px}.item-actions button{background:transparent;color:#a44f39;padding:6px;font-size:13px}.flow-steps{display:flex;gap:7px;margin:14px 0 18px;overflow:auto}.flow-steps span{flex:none;padding:7px 10px;border-radius:999px;background:#e9e1d5;color:#777066;font-size:12px;font-weight:800}.flow-steps span.active{background:#29251f;color:#fffaf0}.flow-steps span.done{background:#df735733;color:#a44f39}.picker-head{display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:14px}.picker-head label{display:grid;gap:7px;color:#716a60;font-size:13px;font-weight:750}select,input{width:100%;border:1px solid #d8d0c2;border-radius:12px;background:#fffaf0;color:#29251f;padding:11px 12px;font:inherit}.category-list{display:flex;gap:7px;overflow:auto;padding:4px 0 12px}.chip{flex:none;border:1px solid #d8d0c2;background:transparent;color:#716a60;border-radius:999px;padding:7px 12px;font-size:13px}.chip.active{background:#29251f;color:#fffaf0}.form-message{color:#777066;font-size:13px}.route-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:8px;max-height:330px;overflow:auto}.route-choice{background:#fffaf0;color:#29251f;border:1px solid #ded6c9;padding:11px 8px}.step{margin-top:24px;padding-top:20px;border-top:1px solid #ded6c9}.step-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.back-button{padding:7px 0;background:transparent;color:#a44f39}.result-card{display:grid;gap:12px}.result-card h2{margin:0;font-size:17px}.result-card p{margin:0}.suggestion-list{display:grid;gap:8px}.check-row{display:flex;align-items:center;gap:10px;padding:11px;border:1px solid #ded6c9;border-radius:12px}.check-row.selected{border-color:#df7357;background:#df73570d}.check-row input{width:auto}.check-row span{flex:1}.check-row em{flex:none;color:#a44f39;font-size:11px;font-style:normal;font-weight:850}.choice{display:grid;gap:5px;text-decoration:none}.empty{color:#777066}.undo-toast{position:fixed;left:50%;bottom:max(24px,env(safe-area-inset-bottom));z-index:10;width:min(calc(100% - 32px),520px);transform:translateX(-50%);display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 16px;border-radius:15px;background:#29251f;color:#fffaf0;box-shadow:0 12px 40px #0004;font-weight:750}.undo-toast[hidden]{display:none}.undo-toast button{padding:7px 9px;background:transparent;color:#f09b80}.route-page{padding-bottom:60px}.route-head{padding:48px 0 28px}.route-badge{display:inline-block;padding:9px 14px;border-radius:999px;background:#29251f;color:#fffaf0;font-weight:850}.route-head h1{margin:18px 0 8px;font-size:clamp(28px,8vw,48px);line-height:1.08;letter-spacing:-.04em}.route-head p{color:#777066}.route-timeline{list-style:none;margin:0;padding:0}.route-stop{position:relative;display:grid;grid-template-columns:24px 1fr auto;gap:12px;min-height:58px}.route-stop:before{content:"";position:absolute;left:8px;top:18px;bottom:-4px;width:2px;background:#d8d0c2}.route-stop:last-child:before{display:none}.dot{position:relative;z-index:1;width:18px;height:18px;border:4px solid #f7f2e8;border-radius:50%;background:#aaa197}.route-stop.selected .dot{background:#df7357;box-shadow:0 0 0 3px #df735744}.route-stop div{display:flex;gap:8px;align-items:flex-start}.route-stop em{color:#df7357;font-size:12px;font-style:normal;font-weight:800}.route-stop>span:last-child{color:#777066;font-size:14px;font-weight:700}@media(max-width:520px){.picker-head{grid-template-columns:1fr}.board-item{align-items:flex-start;flex-direction:column}.bus-row{grid-template-columns:1fr auto}.item-actions{flex-wrap:wrap}}@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background:#211f1b;color:#f8f0e3}.panel{border-color:#464139;background:#2a2722}.board-item,.result-card,.choice,input,select,.route-choice,.check-row{border-color:#4d473e;background:#302c26;color:#f8f0e3}.icon-link,.chip{border-color:#4d473e}.chip.active,.route-badge,.flow-steps span.active{background:#f8f0e3;color:#211f1b}.bus-row,.step{border-color:#4d473e}.eyebrow,.eta-footer,.board-item span,.result-card p,.choice span,.route-head p,.route-stop>span:last-child{color:#aaa197}.route-stop:before{background:#4d473e}.route-stop .dot{border-color:#211f1b}.notice{color:#f09b80}}`

const enhancementStyles = `.add-board-button{width:100%;margin-top:14px;background:transparent;color:#a44f39;border:1px dashed #d0b7a9}.picker-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.board-item{max-height:110px;overflow:hidden;transition:max-height .26s ease,opacity .2s ease,transform .2s ease,background-color .2s ease}.board-item.deleted{justify-content:space-between;background:#29251f;color:#fffaf0}.board-item.deleted span{color:#fffaf0}.board-item.collapsing{max-height:0;min-height:0;padding-top:0;padding-bottom:0;margin:0;opacity:0;transform:scale(.97)}.board-item.restoring{background:#df735733;transform:scale(1.01)}.inline-undo{padding:7px 10px;background:transparent;color:#f09b80}.suggestion-copy{display:grid;gap:3px;min-width:0}.suggestion-main{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.suggestion-main strong{font-size:17px}.suggestion-main b{white-space:nowrap;font-size:15px}.suggestion-copy small{overflow:hidden;color:#777066;text-overflow:ellipsis;white-space:nowrap}.sticky-save{position:sticky;bottom:max(12px,env(safe-area-inset-bottom));z-index:3;width:100%;box-shadow:0 10px 28px #0003}@media(prefers-color-scheme:dark){.add-board-button{border-color:#694d43}.board-item.deleted{background:#f8f0e3;color:#211f1b}.board-item.deleted span{color:#211f1b}.suggestion-copy small{color:#aaa197}}`

function escapeHTML(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;') }
function safeJSON(value: unknown): string { return JSON.stringify(value).replaceAll('<', '\\u003c') }
function formatTaipeiTime(value: string): string { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) }
