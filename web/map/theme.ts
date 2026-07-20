import { readAppearancePreferences } from '../appearance/preferences'

// Leaflet 圖層畫在 canvas/SVG 上，吃不到 CSS custom property。製圖配色與
// 介面、底圖共用同一個「地圖外觀」偏好；切換後重開地圖頁套用。
export const prefersDarkMap = readAppearancePreferences().map === 'dark'

// 依路線名稱 hash 配色的色格。兩組長度一致,hash 對應的色格位置不變。
// 亮色版維持原始褪色紙感六色(米紙底圖寬容,以氛圍優先)。深色版是
// 「霧面陶土・降彩」六色(陶土紅/赭金/苔綠/湖藍/鳶尾紫/玫瑰):色相拉開
// 保辨識(相鄰色正常視覺 ΔE 14.3、色弱模擬 10.9、對深灰底圖對比 ≥ 3:1),
// OKLCH 彩度整體壓到 ~0.085 讓色彩往灰走一步,貼近原始的褪色紙感。
const lightRoutePalette = ['#b85f49', '#4f685b', '#8a674f', '#b08a47', '#765b78', '#6f7561']
const darkRoutePalette = ['#9c5a4f', '#af9151', '#457a51', '#5f9abc', '#71659c', '#c37e93']
export const routePalette = prefersDarkMap ? darkRoutePalette : lightRoutePalette

// 路線折線下方的襯線:亮色時是米紙色暈,深色時改用畫布色,
// 讓彩色線條與反轉後的底圖分離而不發光。
export const routeCasingColor = prefersDarkMap ? '#1d1c19' : '#f4efe4'
// 站點圓點的外圈描邊,同樣跟底圖紙色走。
export const stopHaloColor = prefersDarkMap ? '#28251f' : '#fffaf0'
// 站點與端點標記的填色:深色版與製圖覆寫色一致。
export const stopFillGreen = prefersDarkMap ? '#81a08f' : '#4f685b'
export const stopFillAccent = prefersDarkMap ? '#df7357' : '#b85f49'
