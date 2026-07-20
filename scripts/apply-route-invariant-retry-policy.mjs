import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${label}: expected source block not found`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block is not unique`)
  }
  return source.replace(before, after)
}

function update(path, transform) {
  const source = fs.readFileSync(path, 'utf8')
  fs.writeFileSync(path, transform(source))
}

update('web/route/contract.ts', (source) => {
  let next = replaceOnce(
    source,
    "const MAX_ETA_LABEL_LENGTH = 64\n",
    `const MAX_ETA_LABEL_LENGTH = 64

export class RouteContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteContractError'
  }
}
`,
    'contract error class',
  )
  next = next.replaceAll('throw new Error(', 'throw new RouteContractError(')
  return next
})

update('web/route/identity.ts', (source) => {
  let next = replaceOnce(
    source,
    "const MAX_STOP_NAME_LENGTH = 160\n",
    `const MAX_STOP_NAME_LENGTH = 160

export class RouteIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteIdentityError'
  }
}
`,
    'identity error class',
  )
  next = next.replaceAll('throw new Error(', 'throw new RouteIdentityError(')
  return next
})

update('web/route/main.ts', (source) => {
  let next = replaceOnce(
    source,
    "import { parseRouteEtaResponse } from './contract'\n",
    "import { parseRouteEtaResponse, RouteContractError } from './contract'\n",
    'contract import',
  )
  next = replaceOnce(
    next,
    "import { readRoutePageIdentity } from './identity'\n",
    "import { readRoutePageIdentity, RouteIdentityError } from './identity'\n",
    'identity import',
  )
  next = replaceOnce(
    next,
    `    const tokenRejected = isTdxTokenRejectedError(error)
    setSelectedStatus(page, tokenRejected ? '憑證失效' : '即時未更新')
    console.error(JSON.stringify({ message: 'route_eta_client_failed' }))
    if (tokenRejected) return 'stop'
    return { nextDelayMs: ROUTE_DEGRADED_REFRESH_MS }
`,
    `    const tokenRejected = isTdxTokenRejectedError(error)
    const invariantFailure = error instanceof RouteContractError || error instanceof RouteIdentityError
    setSelectedStatus(page, tokenRejected ? '憑證失效' : '即時未更新')
    console.error(JSON.stringify({
      message: 'route_eta_client_failed',
      failureKind: tokenRejected
        ? 'token-rejected'
        : error instanceof RouteContractError
          ? 'contract'
          : error instanceof RouteIdentityError ? 'identity' : 'transient',
    }))
    if (tokenRejected || invariantFailure) return 'stop'
    return { nextDelayMs: ROUTE_DEGRADED_REFRESH_MS }
`,
    'refresh failure policy',
  )
  next = next
    .replaceAll("throw new Error('Route ETA station count does not match the server identity')", "throw new RouteIdentityError('Route ETA station count does not match the server identity')")
    .replaceAll("throw new Error('Route timeline station count does not match the server identity')", "throw new RouteIdentityError('Route timeline station count does not match the server identity')")
    .replaceAll("throw new Error('Route selected station does not match the server identity')", "throw new RouteIdentityError('Route selected station does not match the server identity')")
    .replaceAll("throw new Error('Route DOM does not match the server identity')", "throw new RouteIdentityError('Route DOM does not match the server identity')")
    .replaceAll("throw new Error('Route ETA response does not match the server identity')", "throw new RouteIdentityError('Route ETA response does not match the server identity')")
  return next
})

update('web/route/contract.test.ts', (source) => {
  let next = replaceOnce(
    source,
    "import { parseRouteEtaResponse } from './contract'",
    "import { parseRouteEtaResponse, RouteContractError } from './contract'",
    'contract test import',
  )
  next = replaceOnce(
    next,
    'expect(() => parseRouteEtaResponse(value)).toThrow()',
    'expect(() => parseRouteEtaResponse(value)).toThrow(RouteContractError)',
    'contract typed assertion',
  )
  return next
})

update('web/route/identity.test.ts', (source) => {
  let next = replaceOnce(
    source,
    "import { parseRoutePageIdentity } from './identity'",
    "import { parseRoutePageIdentity, RouteIdentityError } from './identity'",
    'identity test import',
  )
  next = replaceOnce(
    next,
    'expect(() => parseRoutePageIdentity(value)).toThrow()',
    'expect(() => parseRoutePageIdentity(value)).toThrow(RouteIdentityError)',
    'identity typed assertion',
  )
  return next
})

update('test/e2e/route.spec.ts', (source) => {
  let next = replaceOnce(
    source,
    `  test('keeps the station order and stops retrying a rejected personal token', async ({ page }) => {
`,
    `  test('stops retrying a malformed ETA contract', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({ json: { ...realtime, schemaVersion: 2 } })
    })

    await page.goto(routeUrl)

    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
    await page.clock.fastForward(10 * 60_000)
    expect(requests).toBe(1)
  })

  test('keeps the station order and stops retrying a rejected personal token', async ({ page }) => {
`,
    'malformed contract e2e',
  )
  next = replaceOnce(
    next,
    `  test('rejects a same-name selected stop with the wrong physical identity', async ({ page }) => {
    await page.route('**/api/v1/route-eta*', (route) => route.fulfill({
      json: {
        ...realtime,
        stops: realtime.stops.map((stop, index) => index === 1
          ? { ...stop, stopUid: 'TPE-WRONG' }
          : stop),
      },
    }))

    await page.goto(routeUrl)

    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
  })
`,
    `  test('rejects a same-name selected stop with the wrong physical identity without retrying', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({
        json: {
          ...realtime,
          stops: realtime.stops.map((stop, index) => index === 1
            ? { ...stop, stopUid: 'TPE-WRONG' }
            : stop),
        },
      })
    })

    await page.goto(routeUrl)

    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
    await page.clock.fastForward(10 * 60_000)
    expect(requests).toBe(1)
  })
`,
    'identity mismatch e2e',
  )
  return next
})
