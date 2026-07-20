from pathlib import Path

path = Path('src/lib/tdx.ts')
text = path.read_text(encoding='utf-8')
old = """      const data = await readJsonResponse(cached, maxResponseBytes)\n      if (validPayload(data, options.validate)) {\n        const cachedAt = parsedCacheTimestamp(cached.headers.get('X-Mochi-Cached-At'))\n        const typed = data as T\n        memoryCacheSet(memoryKey, { data: typed, cachedAt }, ttlSeconds)\n        return completeData(\n          typed,\n          'edge',\n          cachedAt === undefined ? undefined : Math.max(0, now() - cachedAt),\n        )\n      }\n"""
new = """      const parsed = await readJsonResponse(cached, maxResponseBytes)\n      if (validPayload(parsed.data, options.validate)) {\n        const cachedAt = parsedCacheTimestamp(cached.headers.get('X-Mochi-Cached-At'))\n        const typed = parsed.data as T\n        memoryCacheSet(memoryKey, { data: typed, cachedAt }, ttlSeconds)\n        return completeData(\n          typed,\n          'edge',\n          cachedAt === undefined ? undefined : Math.max(0, now() - cachedAt),\n        )\n      }\n"""
if text.count(old) != 1:
    raise RuntimeError(f'edge cache reader anchor count: {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
