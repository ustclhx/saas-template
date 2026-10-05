import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { syncLocalPaymentEnv } from './local-payment-env.mjs'

test('local payment overlay preserves auth, clears missing payment values and is removable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'payment-env-'))
  const app = pathToFileURL(`${directory}/`)
  const local = pathToFileURL(join(directory, '.env.local'))
  const target = join(directory, '.dev.vars')
  const environment = process.env
  const keys = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ]
  const saved = Object.fromEntries(keys.map((key) => [key, environment[key]]))
  for (const key of keys) delete environment[key]
  const auth = '# existing auth\nBETTER_AUTH_SECRET="auth-with-$-and-#-characters"\n'
  try {
    writeFileSync(target, auth)
    writeFileSync(
      local,
      'STRIPE_SECRET_KEY=sk_test_fixture\nPAYPAL_CLIENT_SECRET="fixture#value"\nDATABASE_URL=must-not-enter-worker\n',
    )
    syncLocalPaymentEnv(app, local)
    const first = readFileSync(target, 'utf8')
    const bindings = parseEnv(first)
    assert.equal(bindings.BETTER_AUTH_SECRET, 'auth-with-$-and-#-characters')
    assert.equal(bindings.STRIPE_SECRET_KEY, 'sk_test_fixture')
    assert.equal(bindings.PAYPAL_CLIENT_SECRET, 'fixture#value')
    assert.equal(bindings.PAYPAL_WEBHOOK_ID, '')
    assert.equal(bindings.DATABASE_URL, undefined)
    syncLocalPaymentEnv(app, local)
    assert.equal(readFileSync(target, 'utf8'), first)
    writeFileSync(local, 'STRIPE_SECRET_KEY=\n')
    syncLocalPaymentEnv(app, local)
    assert.equal(parseEnv(readFileSync(target, 'utf8')).STRIPE_SECRET_KEY, '')
    const stripeKey = keys[0]
    environment[stripeKey] = 'sk_test_process_override'
    syncLocalPaymentEnv(app, local)
    assert.equal(
      parseEnv(readFileSync(target, 'utf8')).STRIPE_SECRET_KEY,
      'sk_test_process_override',
    )
    rmSync(local)
    syncLocalPaymentEnv(app, local)
    assert.equal(readFileSync(target, 'utf8'), auth)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete environment[key]
      else environment[key] = saved[key]
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
