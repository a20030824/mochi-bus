from pathlib import Path

TDX = Path('src/lib/tdx.ts')
TEST = Path('src/lib/tdx-resolution.test.ts')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


text = TDX.read_text()
text = replace_once(
    text,
    """  const flightKey = dataFlightKey(credentialKey, url, maxResponseBytes, options.operation)
""",
    """  const flightKey = dataFlightKey(
    credentialKey,
    url,
    maxResponseBytes,
    ttlSeconds,
    options.operation,
    Boolean(options.validate),
  )
""",
    'flight key call',
)
text = replace_once(
    text,
    """function dataFlightKey(
  credentialKey: string,
  url: URL,
  maxResponseBytes: number,
  operation?: TelemetryTdxOperation,
): string {
  return `${credentialKey}\\0${operation ?? 'default'}\\0${maxResponseBytes}\\0${url.toString()}`
}
""",
    """function dataFlightKey(
  credentialKey: string,
  url: URL,
  maxResponseBytes: number,
  ttlSeconds: number,
  operation: TelemetryTdxOperation | undefined,
  validatesPayload: boolean,
): string {
  return [
    credentialKey,
    operation ?? 'default',
    maxResponseBytes,
    ttlSeconds,
    validatesPayload ? 'validated' : 'unvalidated',
    url.toString(),
  ].join('\\0')
}
""",
    'flight key definition',
)
TDX.write_text(text)


test = TEST.read_text()
anchor = "  it('coalesces concurrent shared-token requests without mixing data URLs', async () => {\n"
index = test.find(anchor)
if index < 0:
    raise RuntimeError('test anchor not found')
addition = r'''  it('does not coalesce requests with different cache or validation policies', async () => {
    const responders: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      responders.push(resolve)
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
    })

    const ttlUrl = new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=singleflight-ttl')
    const ttlRequests = [
      fetchTDXJson(observedEnv([]), ttlUrl, 15, options),
      fetchTDXJson(observedEnv([]), ttlUrl, 30, options),
    ]
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    responders.splice(0).forEach((resolve) => resolve(new Response(JSON.stringify([{ id: 'ttl' }]))))
    await expect(Promise.all(ttlRequests)).resolves.toHaveLength(2)

    resetMemoryCacheForTests()
    const validationUrl = new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=singleflight-validation')
    const validationRequests = [
      fetchTDXJson(observedEnv([]), validationUrl, 0, options),
      fetchTDXJson(observedEnv([]), validationUrl, 0, {
        operation: options.operation,
        city: options.city,
      }),
    ]
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    responders.splice(0).forEach((resolve) => resolve(new Response(JSON.stringify([{ id: 'validation' }]))))
    await expect(Promise.all(validationRequests)).resolves.toHaveLength(2)
  })

'''
test = test[:index] + addition + test[index:]
TEST.write_text(test)
