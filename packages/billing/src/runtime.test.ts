import { expect, it, vi } from 'vitest'
import { createTestPaymentRuntime } from './runtime.ts'

it('keeps missing payment configuration offline and rejects live Stripe keys', () => {
  const fetch = vi.fn()
  expect(createTestPaymentRuntime({}, ['stripe', 'paypal'], { fetch }).readiness).toEqual([
    { id: 'stripe', available: false },
    { id: 'paypal', available: false },
  ])
  expect(fetch).not.toHaveBeenCalled()
  expect(() =>
    createTestPaymentRuntime({ STRIPE_SECRET_KEY: 'sk_live_fixture' }, ['stripe'], { fetch }),
  ).toThrow()
  expect(fetch).not.toHaveBeenCalled()
})
