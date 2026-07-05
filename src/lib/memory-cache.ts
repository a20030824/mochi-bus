// Workers 的 isolate 會跨請求存活,模組層 Map 就是零成本的同機快取
// (getTDXToken 的 tokenCache 已用同一招)。Cache API 在 workers.dev 上是
// no-op、在自訂網域上也只限同機房,所以這層放在最前面擋重複請求;
// 跨 isolate 不共享,但這裡的 TTL 都短,漏接的就交給後面的 Cache API。
// 注意:回傳的是同一個物件參考,呼叫端不可以就地修改快取到的值。
type Entry = { value: unknown; expiresAt: number }

const store = new Map<string, Entry>()
const MAX_ENTRIES = 500

export function memoryCacheGet<T>(key: string): T | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    store.delete(key)
    return undefined
  }
  return entry.value as T
}

export function memoryCacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const now = Date.now()
    for (const [staleKey, entry] of store) {
      if (entry.expiresAt <= now) store.delete(staleKey)
    }
    // 清完過期還是滿:丟最舊的一批(Map 保插入順序),避免無上限成長。
    if (store.size >= MAX_ENTRIES) {
      for (const oldestKey of [...store.keys()].slice(0, Math.ceil(MAX_ENTRIES / 5))) {
        store.delete(oldestKey)
      }
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
}
