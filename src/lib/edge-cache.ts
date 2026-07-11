export type BackgroundTaskScheduler = (promise: Promise<unknown>) => void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function cacheMatchFailOpen(
  cache: Cache,
  key: Request,
  context: string,
): Promise<Response | undefined> {
  try {
    return await cache.match(key)
  } catch (error) {
    console.error(JSON.stringify({
      message: 'edge_cache_read_failed',
      context,
      error: errorMessage(error),
    }))
    return undefined
  }
}

export async function cachePutFailOpen(
  cache: Cache,
  key: Request,
  response: Response,
  context: string,
  schedule?: BackgroundTaskScheduler,
): Promise<void> {
  const task = Promise.resolve()
    .then(() => cache.put(key, response))
    .catch((error) => {
      console.error(JSON.stringify({
        message: 'edge_cache_write_failed',
        context,
        error: errorMessage(error),
      }))
    })

  if (schedule) {
    try {
      schedule(task)
      return
    } catch (error) {
      console.error(JSON.stringify({
        message: 'edge_cache_schedule_failed',
        context,
        error: errorMessage(error),
      }))
    }
  }

  await task
}
