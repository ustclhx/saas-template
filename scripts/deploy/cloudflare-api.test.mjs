import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CloudflareApiError,
  createCloudflareApi,
  originFromConnectionString,
} from './cloudflare-api.mjs'
import { fakeCloudflare } from './test-fixtures.mjs'

const SECRET_URL = 'postgres://app:s3cr%40t-pass@db.example.com:6543/saas_staging'
const api = (fake) => createCloudflareApi({ token: 'tok', accountId: 'acct', fetch: fake.fetch })

test('lists walk every page for page- and cursor-based endpoints', async () => {
  const fake = fakeCloudflare({
    kv: Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, title: `kv-${i}` })),
    r2: Array.from({ length: 5 }, (_, i) => ({ name: `bucket-${i}` })),
    queue: Array.from({ length: 3 }, (_, i) => ({ queue_id: `q${i}`, queue_name: `queue-${i}` })),
    hyperdrive: [{ id: 'h0', name: 'hd' }],
  })
  const client = api(fake)
  assert.deepEqual(
    (await client.list('kv')).map((item) => item.name),
    [0, 1, 2, 3, 4].map((i) => `kv-${i}`),
  )
  assert.deepEqual((await client.list('r2')).at(-1), { id: 'bucket-4', name: 'bucket-4' })
  assert.deepEqual(
    await client.list('queue'),
    [0, 1, 2].map((i) => ({ id: `q${i}`, name: `queue-${i}` })),
  )
  assert.deepEqual(await client.list('hyperdrive'), [{ id: 'h0', name: 'hd' }])
  assert.equal(fake.calls.filter((call) => call.kind === 'kv').length, 3)
  assert.equal(fake.calls.filter((call) => call.kind === 'r2').length, 3)
  assert.match(fake.calls[0].path, /^\/client\/v4\/accounts\/acct\/storage\/kv\/namespaces$/)
  assert.equal(fake.calls[0].headers.authorization, 'Bearer tok')
})

test('lists keep duplicate names so the caller can refuse to pick one', async () => {
  const fake = fakeCloudflare({
    hyperdrive: [
      { id: 'h1', name: 'hyperdrive-staging' },
      { id: 'h2', name: 'other' },
      { id: 'h3', name: 'hyperdrive-staging' },
    ],
  })
  const same = (await api(fake).list('hyperdrive')).filter(
    (item) => item.name === 'hyperdrive-staging',
  )
  assert.deepEqual(
    same.map((item) => item.id),
    ['h1', 'h3'],
  )
})

test('creates use the documented request bodies', async () => {
  const fake = fakeCloudflare()
  const client = api(fake)
  assert.equal((await client.create('kv', 'cache-staging')).name, 'cache-staging')
  assert.deepEqual(await client.create('r2', 'files-staging'), {
    id: 'files-staging',
    name: 'files-staging',
  })
  assert.ok((await client.create('queue', 'email-staging')).id)
  const bodies = fake.calls.map((call) => call.body)
  assert.deepEqual(bodies, [
    { title: 'cache-staging' },
    { name: 'files-staging' },
    { queue_name: 'email-staging' },
  ])
})

test('403 becomes a missing-permission error with status and codes only', async () => {
  const fake = fakeCloudflare({}, { deny: { 'queue:create': 403, 'kv:list': 403 } })
  const client = api(fake)
  await assert.rejects(client.create('queue', 'email-staging'), (error) => {
    assert.ok(error instanceof CloudflareApiError)
    assert.equal(error.status, 403)
    assert.deepEqual(error.codes, [10000])
    assert.match(error.message, /缺少「Queues Write」权限/)
    assert.doesNotMatch(error.message, /secret body echo/)
    return true
  })
  await assert.rejects(client.list('kv'), /Workers KV Storage Read/)
  // 已存在同名 KV 时 400：保留状态与错误码
  const dup = fakeCloudflare({ kv: [{ id: 'k', title: 'cache-staging' }] })
  await assert.rejects(api(dup).create('kv', 'cache-staging'), /HTTP 400，Cloudflare 错误码 10014/)
})

test('hyperdrive create puts the connection string only in the request body', async () => {
  const fake = fakeCloudflare()
  const client = api(fake)
  const plain = await client.create('hyperdrive', 'hyperdrive-staging', {
    connectionString: SECRET_URL,
  })
  const cached = await client.create('hyperdrive', 'hyperdrive-cached-staging', {
    connectionString: SECRET_URL,
    cached: true,
  })
  assert.deepEqual(Object.keys(plain).sort(), ['id', 'name'])
  assert.doesNotMatch(JSON.stringify([plain, cached]), /s3cr|db\.example/)
  const [first, second] = fake.calls.map((call) => call.body)
  assert.deepEqual(first.origin, {
    scheme: 'postgres',
    host: 'db.example.com',
    port: 6543,
    database: 'saas_staging',
    user: 'app',
    password: 's3cr@t-pass',
  })
  assert.deepEqual(first.caching, { disabled: true })
  assert.deepEqual(second.caching, { disabled: false, max_age: 60 })
  for (const call of fake.calls) assert.doesNotMatch(call.path + call.query, /s3cr/)

  const failing = fakeCloudflare({}, { deny: { 'hyperdrive:create': 403 } })
  await assert.rejects(
    api(failing).create('hyperdrive', 'hd', { connectionString: SECRET_URL }),
    (error) => {
      assert.match(error.message, /Hyperdrive Write/)
      assert.doesNotMatch(error.message, /s3cr|db\.example|app:/)
      return true
    },
  )
})

test('connection string errors never echo the input', () => {
  for (const value of ['not a url s3cr', 'mysql://u:s3cr@h/db', 'postgres://u@h/db', undefined])
    assert.throws(
      () => originFromConnectionString(value),
      (error) => !String(error.message).includes('s3cr'),
    )
  assert.equal(originFromConnectionString('postgresql://u:p@h/d').port, 5432)
})

test('network failures keep only the error category', async () => {
  const client = createCloudflareApi({
    token: 'tok',
    accountId: 'acct',
    fetch: async () => {
      throw new TypeError('fetch failed for https://api.cloudflare.com?token=tok', {
        cause: { code: 'ENOTFOUND' },
      })
    },
  })
  await assert.rejects(client.list('kv'), (error) => {
    assert.match(error.message, /ENOTFOUND/)
    assert.doesNotMatch(error.message, /tok/)
    return true
  })
  assert.throws(() => createCloudflareApi({ token: '', accountId: 'a' }), /CLOUDFLARE_API_TOKEN/)
})
