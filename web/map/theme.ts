import { readAppearancePreferences } from '../appearance/preferences'

// Leaflet 圖屋畫在 canvas/SVG 上,吃不到 CSS custom property。製圖色只跟
// 「地圖底圖」偏好走,不跟地圖介面或系統主題混在一起;切換後重開地圖頁套用。
export const prefersDarkMap = readAppearancePreferences().mapTiles === 'dark'

// 依路線名稱 hash 配色的色格。深色版同色相提高明度,讓 5px 色條、折線在
// 暗紙與反轉底圖上保持可辨識;兩組長度一致,hash 對應的色格位置不變。
const lightRoutePalette = ['#b85f49', '#4f685b', '#8a674f', '#b08a47', '#765b78', '#6f7561']
const darkRoutePalette = ['#d98a72', '#7fa08f', '#b08d72', '#cfa964', '#a487a6', '#9aa189']
export const routePalette = prefersDarkMap ? darkRoutePalette : lightRoutePalette

// 路線折線下方的襯線:亮色時是米紙色暈,深色時改用畫布色,
// 讓彩色線條與反轉後的底圖分離而不發光。
export const routeCasingColor = prefersDarkMap ? '#1d1c19' : '#f4efe4'
// 站點圓點的外圈描邊,同樣跟底圖紙色走。
export const stopHaloColor = prefersDarkMap ? '#28251f' : '#fffaf0'
// 站點與端點標記的填色:深色版與製圖覆寫色一致。
export const stopFillGreen = prefersDarkMap ? '#81a08f' : '#4f685b'
export const stopFillAccent = prefersDarkMap ? '#df7357' : '#b85f49'
