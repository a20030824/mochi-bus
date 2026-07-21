import { expect, test } from './stateful-fixtures'

test.describe.configure({ mode: 'serial' })

test('can mutate shared TDX module state inside the stateful Worker suite', async ({ request }) => {
  const initial = await request.get('/__test/tdx-state/status')
  expect(initial.status()).toBe(200)
  await expect(initial.json()).resolves.toEqual({ warning: 'tdx-rate-limit' })

  const poison = await request.post('/__test/tdx-state/poison')
  expect(poison.status()).toBe(204)

  const polluted = await request.get('/__test/tdx-state/status')
  await expect(polluted.json()).resolves.toEqual({ warning: 'tdx-quota' })
})

test('starts the next stateful case from a reset TDX module state', async ({ request }) => {
  const response = await request.get('/__test/tdx-state/status')
  expect(response.status()).toBe(200)
  await expect(response.json()).resolves.toEqual({ warning: 'tdx-rate-limit' })
})
