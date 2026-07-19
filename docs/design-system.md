# Mochi Bus design system

## North star

> 用排版建立結構，不用盒子；用一種顏色說一件事；數字是主角。

Mochi Bus 的參照不是通用元件模板，而是鐵路時刻表、巴士站牌與紙票根：

- 同質資訊用節奏與細規線組成清單，異質或互斥方案才使用卡片。
- 赤陶紅只表示即時性、警示或主要動作；橄欖綠表示地圖、路網與次要動作。
- 路線色只用於辨識路線，不作一般裝飾。
- ETA、時刻、距離與站數使用 tabular numerals；重要數字必須先於輔助文字被看見。

## Two related personalities

品牌色與字體（`ui-rounded` / SF Pro Rounded / PingFang TC）在所有頁面共用，但材質與幾何刻意分成兩種人格：

- 地圖頁是製圖與票根：小圓角、細規線、米紙、低陰影。
- 封面與設定頁是圓潤看板：較大圓角、較柔和的表面與更大的展示字。

不要為了 token 共用而強迫兩種頁面使用相同的 `paper`、`surface` 或圓角值。共用的是語意，不一定是最終色值。

## Semantic tokens

### Brand

- `--ink`: 主要文字。
- `--accent`, `--accent-deep`: 即時性、警示、主要動作。
- `--green`, `--green-deep`: 地圖、路網、次要動作。

### Text

- `--text-muted`: 必要的次要資訊；在所在表面上須達 WCAG AA 一般文字對比。
- `--text-faint`: 非必要資訊，僅可用於較大文字、致謝或裝飾。

資料可信度另用三個跨頁語意 token，不以父元素 `opacity` 表達：

- `--ink-live`: 即時或確定資料。
- `--ink-estimated`: 時刻表推估、已過班次等較低精度資訊。
- `--ink-urgent`: 即將到站、異常或需要立即注意的狀態。

不能只依「看起來夠深」判斷文字色。任何 18px 以下的必要文字在實際背景上都要至少 4.5:1。

### Rules and surfaces

- `--line`: 元件邊界。
- `--line-faint`: 清單分隔與卡片內規線。
- `--line-strong`: selected、可按暗示或強邊界。
- `--canvas`: 頁面或地圖畫布。
- `--paper`: drawer、浮起層。
- `--surface`: 清單 hover、次級區塊或卡片。

### Elevation

地圖頁只有三層：

1. 地圖畫布。
2. marker 與地圖控制。
3. drawer、toast。

卡片不使用陰影。陰影不能被用來補救不足的間距或對比。

## Type scale

地圖 drawer 使用五級：

| Role | Size / weight | Use |
| --- | --- | --- |
| Display | 30px / 850 | drawer 主標 |
| Number | 22px / 850 / tabular | ETA、重要時刻 |
| Body | 15px / 750 | 路名、站名、卡片主文 |
| Caption | 12px / 400–650 | 方向、距離、輔助說明 |
| Label | 11px / 800 / tracking | 出發、目的地、欄位標籤 |

一個列或卡片最多使用三個層級。最小可見文字為 11px。

## Spacing and radius

新增樣式優先使用 4 / 8 的間距尺度，但現有奇數值不能機械取整。只有在截圖與短螢幕佈局確認後才調整，避免破壞字型基線、觸控高度與 drawer 的固定 header。

地圖頁：

- `--radius-control`: 4px。
- `--radius-drawer`: 8px。
- pill 只用於 chip、狀態與章戳。
- `50%` 只用於真正的圓形控制。

封面與設定頁保留 8–24px 的圓潤層級。

## Interaction rules

- 可按列的整列都是 hit target；內嵌次要動作仍須有至少 42px 觸控區。
- hover 不能是唯一的 affordance。
- focus ring 必須在相鄰列與 overflow 容器中仍可見。
- 顏色、圓點或 icon 不能單獨傳達 freshness、錯誤、selected 等必要狀態。
- `prefers-reduced-motion` 下所有內容仍須具有可辨識的靜態 pending 狀態。
- drawer 內容進場固定使用 180ms、4px；只有 view identity 改變才播放。ETA／車輛刷新、收藏、loading 完成與 stale response 不重播。
- 紙紋只可出現在 drawer 或紙面表面，濃度維持 2%–4%，不得覆蓋地圖或攔截互動。

## ETA language

首頁、站牌到站、直達與轉乘應共用同一套呈現規則：

- `7 分`: 即時到站。
- `約 7 分`: 時刻表推估。
- `7 分後發車`: 只有起點發車資料。
- `5–10 分一班`: 班距資料。
- 超過 60 分鐘的特定班次改顯示絕對時刻。
- stale 資料必須保留可見文字，例如「稍早」；圓點只能作輔助。

資料格式化應由共用 presentation helper 完成，不得在不同 DOM renderer 內各自重寫門檻與詞彙。

ETA 更新維持短 crossfade。數字翻牌若沒有實機閱讀證據，不加入列表或 Cover；LED 跑馬燈維持連續、可預測的移動，不加入可能切斷語句的中段停頓。

## Timetable language

- 今日固定班次分為 `past / next / future`；三者維持相同 chip 尺寸，避免時間流逝造成版面跳動。
- 過去班次使用淡墨與透明底；下一班使用赤陶紅並保留「下一班」文字替代；未來班次使用全墨。
- `24:10`、`25:30` 等延伸時刻以服務日起算分鐘判斷。台北時間凌晨四點前仍屬前一服務日，後端 `today` 與前端狀態必須共用同一服務時鐘。
- 非今日服務 tab 的班次全部視為 future，不得標成已過或下一班。

## Review checklist

- 必要的小字是否達 4.5:1？
- 同質列是否仍被不必要的獨立盒子包住？
- 路線色是否只在識別路線？
- 一張卡是否超過三個字級？
- 所有時間、分鐘、距離、站數是否使用 tabular numerals？
- selected、focus、stale 是否不只靠顏色？
- 390×844、420×480、636×381 是否仍能保留 drawer header 和主要控制？
- drawer 幾何改動是否重新跑過 camera-padding、scroll fade 與 keyboard E2E？
