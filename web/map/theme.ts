import { readAppearancePreferences } from '../appearance/preferences'

// Leaflet 圖屋畫在 canvas/SVG 上,吃不到 CSS custom property。製圖色只跟
// 「地圖底圖」偏好走,不跟地圖介面或系統主題混在一起;切換後重開地圖頁套用。
export const prefersDarkMap = readAppearancePreferences().mapTiles === 'dark'

// 依路線名稱 hash 配色的色格。六槽固定色相(綠/藍/芥末金/磚紅/紫/玫瑰),
// 兩組同槽同色相、長度一致,hash 對應的色格位置不變。色值經 OKLCH 驗證:
// 明度落在該模式色帶內、彩度不低於灰感下限、相鄰兩色正常視覺 ΔE ≥ 15、
// 色弱模擬 ΔE ≥ 8(線條另有襯線與 tooltip 作次要編碼)、對底圖對比 ≥ 3:1。
const lightRoutePalette = ['#0f6e42', '#2a6da6', '#997107', '#963310', '#6a4fae', '#c04e68']
const darkRoutePalette = ['#1e7a54', '#5f8fc9', '#ac942c', '#bd5034', '#8268c9', '#d8697e']
export const routePalette = prefersDarkMap ? darkRoutePalette : lightRoutePalette

// 路線折線下方的襯線:亮色時是米紙色暈,深色時改用畫布色,
// 讓彩色線條與反轉後的底圖分離而不發光。
export const routeCasingColor = prefersDarkMap ? '#1d1c19' : '#f4efe4'
// 站點圓點的外圈描邊,同樣跟底圖紙色走。
export const stopHaloColor = prefersDarkMap ? '#28251f' : '#fffaf0'
// 站點與端點標記的填色:深色版與製圖覆寫色一致。
export const stopFillGreen = prefersDarkMap ? '#81a08f' : '#4f685b'
export const stopFillAccent = prefersDarkMap ? '#df7357' : '#b85f49'
