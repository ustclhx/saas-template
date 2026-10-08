import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let createTestPaymentRuntime: typeof import('./runtime.ts').createTestPaymentRuntime

beforeEach(async () => {
  // 重载模块模拟新的 isolate，不为测试暴露生产告警状态的重置接口。
  vi.resetModules()
  const runtime = await import('./runtime.ts')
  createTestPaymentRuntime = runtime.createTestPaymentRuntime
})

afterEach(() => vi.restoreAllMocks())

it('keeps missing payment configuration offline and rejects live Stripe keys', () => {
  const fetch = vi.fn()
  const warn = vi.fn()
  expect(createTestPaymentRuntime({}, ['stripe', 'paypal'], { fetch, warn }).readiness).toEqual([
    { id: 'stripe', available: false },
    { id: 'paypal', available: false },
  ])
  expect(warn.mock.calls).toEqual([
    ['stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']],
    ['paypal', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID']],
  ])
  expect(fetch).not.toHaveBeenCalled()
  expect(() =>
    createTestPaymentRuntime({ STRIPE_SECRET_KEY: 'sk_live_fixture' }, ['stripe'], { fetch, warn }),
  ).toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

it('warns only about missing PayPal credentials when a client ID is configured', () => {
  const warn = vi.fn()
  const runtime = createTestPaymentRuntime({ PAYPAL_CLIENT_ID: 'client-fixture' }, ['paypal'], {
    warn,
  })
  expect(runtime.readiness).toEqual([{ id: 'paypal', available: false }])
  expect(warn).toHaveBeenCalledExactlyOnceWith('paypal', [
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ])
})

it('does not warn or perform requests when both enabled providers are configured', () => {
  const warn = vi.fn()
  const fetch = vi.fn()
  const runtime = createTestPaymentRuntime(
    {
      STRIPE_SECRET_KEY: 'sk_test_fixture',
      STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
      PAYPAL_CLIENT_ID: 'client-fixture',
      PAYPAL_CLIENT_SECRET: 'secret-fixture',
      PAYPAL_WEBHOOK_ID: 'webhook-fixture',
    },
    ['stripe', 'paypal'],
    { warn, fetch, cache: { get: vi.fn(), put: vi.fn() } },
  )
  expect(runtime.readiness).toEqual([
    { id: 'stripe', available: true },
    { id: 'paypal', available: true },
  ])
  expect(warn).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('warns once per provider across repeated construction in the same isolate', () => {
  const firstWarn = vi.fn()
  const secondWarn = vi.fn()
  createTestPaymentRuntime({}, ['stripe'], { warn: firstWarn })
  createTestPaymentRuntime({}, ['stripe', 'paypal'], { warn: secondWarn })
  createTestPaymentRuntime({}, ['paypal'], { warn: secondWarn })
  expect(firstWarn).toHaveBeenCalledExactlyOnceWith('stripe', [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ])
  expect(secondWarn).toHaveBeenCalledExactlyOnceWith('paypal', [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ])
})

it('records default structured warnings containing variable names without credential values', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_private_fixture',
    PAYPAL_CLIENT_SECRET: 'private-secret-fixture',
    PAYPAL_WEBHOOK_ID: 'private-webhook-fixture',
  }
  createTestPaymentRuntime(env, ['stripe', 'paypal'])
  expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    {
      level: 'warn',
      event: 'billing.provider_unconfigured',
      provider: 'stripe',
      missing: ['STRIPE_WEBHOOK_SECRET'],
    },
    {
      level: 'warn',
      event: 'billing.provider_unconfigured',
      provider: 'paypal',
      missing: ['PAYPAL_CLIENT_ID'],
    },
  ])
  const lines = JSON.stringify(output.mock.calls)
  for (const value of Object.values(env)) expect(lines).not.toContain(value)
})

it('does not warn about disabled providers with missing credentials', () => {
  const warn = vi.fn()
  expect(createTestPaymentRuntime({}, [], { warn }).readiness).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})
