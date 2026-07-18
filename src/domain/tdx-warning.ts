export type TDXWarning = 'tdx-rate-limit' | 'tdx-quota' | 'tdx-unavailable'

// Worker、地圖與首頁共用同一份降級說明；API 只傳穩定的 warning code。
export const tdxWarningMessages: Record<TDXWarning, string> = {
  'tdx-rate-limit': 'TDX 即時查詢暫時受限（額度或頻率），地圖與已同步路網仍可使用。',
  'tdx-quota': '共用的 TDX 額度可能已用完，暫時查不到即時到站；地圖與已同步路網仍可使用，也可到「我的公車」的進階設定填自己的 TDX 憑證。',
  'tdx-unavailable': 'TDX 暫時連不上，地圖與已同步路網仍可使用。',
}
