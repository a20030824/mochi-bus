import type { BusQuery } from './domain/bus-query'

export const defaultBusQuery: BusQuery = {
  city: 'Taipei',
  routeName: '307',
  stopName: '捷運西門站',
  stopUid: 'TPE213044',
  routeUid: 'TPE19108',
  direction: 0,
}

export const supportedCities = [
  ['Taipei', '臺北市'],
  ['NewTaipei', '新北市'],
  ['Taoyuan', '桃園市'],
  ['Taichung', '臺中市'],
  ['Tainan', '臺南市'],
  ['Kaohsiung', '高雄市'],
  ['Keelung', '基隆市'],
  ['Hsinchu', '新竹市'],
  ['HsinchuCounty', '新竹縣'],
  ['MiaoliCounty', '苗栗縣'],
  ['ChanghuaCounty', '彰化縣'],
  ['NantouCounty', '南投縣'],
  ['YunlinCounty', '雲林縣'],
  ['Chiayi', '嘉義市'],
  ['ChiayiCounty', '嘉義縣'],
  ['PingtungCounty', '屏東縣'],
  ['YilanCounty', '宜蘭縣'],
  ['HualienCounty', '花蓮縣'],
  ['TaitungCounty', '臺東縣'],
  ['KinmenCounty', '金門縣'],
  ['PenghuCounty', '澎湖縣'],
  ['LienchiangCounty', '連江縣'],
] as const

export const supportedCityCodes = new Set<string>(supportedCities.map(([code]) => code))
