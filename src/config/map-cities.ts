export type MapCity = {
  code: string
  name: string
  region: 'north' | 'central' | 'south' | 'east' | 'islands'
  center: [number, number]
  // 縣市按鈕在區域總覽的視覺偏移(像素,+x 右 +y 下),不影響 center 的實際地理定位。
  // 只給幾個中心點物理距離太近、按鈕會疊在一起的縣市(市被縣包住的那幾組)。
  labelOffset?: [number, number]
}

export const mapCities: MapCity[] = [
  { code: 'Taipei', name: '臺北', region: 'north', center: [25.052, 121.548], labelOffset: [0, -7] },
  { code: 'NewTaipei', name: '新北', region: 'north', center: [25.013, 121.465], labelOffset: [10, 13] },
  { code: 'Taoyuan', name: '桃園', region: 'north', center: [24.993, 121.301] },
  { code: 'Keelung', name: '基隆', region: 'north', center: [25.128, 121.741] },
  { code: 'Hsinchu', name: '新竹市', region: 'north', center: [24.804, 120.968], labelOffset: [-6, 7] },
  { code: 'HsinchuCounty', name: '新竹縣', region: 'north', center: [24.839, 121.018], labelOffset: [7, -7] },
  { code: 'MiaoliCounty', name: '苗栗', region: 'central', center: [24.56, 120.821] },
  { code: 'Taichung', name: '臺中', region: 'central', center: [24.147, 120.674], labelOffset: [5, -6] },
  { code: 'ChanghuaCounty', name: '彰化', region: 'central', center: [24.076, 120.544], labelOffset: [-5, 6] },
  { code: 'NantouCounty', name: '南投', region: 'central', center: [23.91, 120.684] },
  { code: 'YunlinCounty', name: '雲林', region: 'central', center: [23.708, 120.535] },
  { code: 'Chiayi', name: '嘉義市', region: 'south', center: [23.48, 120.449], labelOffset: [0, -3] },
  { code: 'ChiayiCounty', name: '嘉義縣', region: 'south', center: [23.452, 120.255], labelOffset: [-2, 10] },
  { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] },
  { code: 'Kaohsiung', name: '高雄', region: 'south', center: [22.627, 120.301], labelOffset: [-5, 6] },
  { code: 'PingtungCounty', name: '屏東', region: 'south', center: [22.672, 120.488], labelOffset: [5, -6] },
  { code: 'YilanCounty', name: '宜蘭', region: 'east', center: [24.754, 121.754] },
  { code: 'HualienCounty', name: '花蓮', region: 'east', center: [23.992, 121.611] },
  { code: 'TaitungCounty', name: '臺東', region: 'east', center: [22.755, 121.15] },
  { code: 'PenghuCounty', name: '澎湖', region: 'islands', center: [23.571, 119.579] },
  { code: 'KinmenCounty', name: '金門', region: 'islands', center: [24.432, 118.318] },
  { code: 'LienchiangCounty', name: '馬祖', region: 'islands', center: [26.16, 119.951] },
]
