import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyResolution,
  collectResources,
  conventionalName,
  isPlaceholderId,
  missingProjectVars,
  namingFromWorker,
  rateLimitConflicts,
  stage,
} from './resources-lib.mjs'
import { generated, template } from './test-fixtures.mjs'

const byKey = (resources) => Object.fromEntries(resources.map((item) => [item.key, item]))

test('placeholder check matches missing ids and the generator format only', () => {
  for (const id of [
    undefined,
    null,
    '',
    '00000000000000000000000000000000',
    `${'0'.repeat(24)}ab12cd34`,
  ])
    assert.equal(isPlaceholderId(id), true, String(id))
  for (const id of ['f4d49b7c082b4f01ae20335683d3a21b', `${'0'.repeat(23)}1abcdef01`, 'not-an-id'])
    assert.equal(isPlaceholderId(id), false, id)
})

test('naming comes from the web Worker name', () => {
  assert.deepEqual(namingFromWorker('web-staging'), { prefix: '', suffix: '-staging' })
  assert.deepEqual(namingFromWorker('acme-web-production'), {
    prefix: 'acme-',
    suffix: '-production',
  })
  assert.deepEqual(namingFromWorker('acme-web-web-staging'), {
    prefix: 'acme-web-',
    suffix: '-staging',
  })
  assert.throws(() => namingFromWorker('frontend-staging'), /web Worker/)
  assert.throws(() => namingFromWorker('webapp-staging'), /web Worker/)
  const naming = { prefix: 'acme-', suffix: '-staging' }
  assert.equal(conventionalName('CACHE', naming), 'acme-cache-staging')
  assert.equal(conventionalName('HYPERDRIVE_CACHED', naming), 'acme-hyperdrive-cached-staging')
})

test('template staging is fully pinned and shares KV / Hyperdrive between apps', () => {
  const { naming, resources, pinned } = collectResources(template(), 'staging')
  assert.deepEqual(naming, { prefix: '', suffix: '-staging' })
  assert.equal(pinned, true)
  const map = byKey(resources)
  assert.equal(map['kv:CACHE'].id, 'f4d49b7c082b4f01ae20335683d3a21b')
  assert.equal(map['kv:CACHE'].source, 'fixed')
  assert.deepEqual(map['kv:CACHE'].apps, ['web', 'jobs'])
  assert.equal(map['hyperdrive:HYPERDRIVE_CACHED'].name, 'hyperdrive-cached-staging')
  // R2 与队列按配置名称合并，死信队列被标记并排在其他队列之前
  assert.deepEqual(map['r2:files-staging'].apps, ['web', 'jobs'])
  assert.equal(map['queue:events-dlq-staging'].deadLetter, true)
  const order = resources.map(stage)
  assert.ok(order.indexOf('dlq') < order.indexOf('queue'))
  assert.deepEqual(
    resources.filter((item) => item.kind === 'queue').map((item) => item.name)[0],
    'events-dlq-staging',
  )
  assert.deepEqual(rateLimitConflicts(template()), [])
})

test('generator placeholders become unresolved with conventional names', () => {
  for (const environment of ['staging', 'production']) {
    const { resources, pinned } = collectResources(generated(), environment)
    assert.equal(pinned, false)
    const map = byKey(resources)
    for (const key of ['kv:CACHE', 'hyperdrive:HYPERDRIVE', 'hyperdrive:HYPERDRIVE_CACHED'])
      assert.equal(map[key].source, 'unresolved', `${environment} ${key}`)
    assert.equal(map['kv:CACHE'].name, `acme-cache-${environment}`)
    assert.equal(map['hyperdrive:HYPERDRIVE'].name, `acme-hyperdrive-${environment}`)
    assert.ok(map[`r2:acme-files-${environment}`])
    assert.ok(map[`queue:acme-events-dlq-${environment}`].deadLetter)
  }
})

test('a plugin KV is collected without hard-coded binding names', () => {
  const configs = generated()
  configs.web.env.staging.kv_namespaces.push({
    binding: 'AGENT_STATE',
    id: `${'0'.repeat(24)}000000ff`,
  })
  configs.jobs.env.staging.kv_namespaces.push({ binding: 'AGENT_STATE' })
  const map = byKey(collectResources(configs, 'staging').resources)
  assert.equal(map['kv:AGENT_STATE'].name, 'acme-agent-state-staging')
  assert.deepEqual(map['kv:AGENT_STATE'].apps, ['web', 'jobs'])
})

test('different pinned ids for one shared binding fail; one pinned side is shared', () => {
  const conflict = template()
  conflict.jobs.env.staging.kv_namespaces[0].id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  assert.throws(() => collectResources(conflict, 'staging'), /不同的 ID/)

  const half = generated()
  half.web.env.staging.kv_namespaces[0].id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const { resources } = collectResources(half, 'staging')
  const kv = byKey(resources)['kv:CACHE']
  assert.equal(kv.source, 'fixed')
  for (const item of resources) if (!item.id) item.id = `id-${item.name}`
  const jobs = applyResolution(half.jobs, 'jobs', 'staging', resources)
  assert.equal(jobs.env.staging.kv_namespaces[0].id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
})

test('resolution fills only the target environment and empty account vars', () => {
  const configs = generated()
  const { resources } = collectResources(configs, 'production')
  for (const item of resources) if (item.source === 'unresolved') item.id = `id-${item.name}`
  const web = applyResolution(configs.web, 'web', 'production', resources, { accountId: 'acct' })
  const production = web.env.production
  assert.equal(production.kv_namespaces[0].id, 'id-acme-cache-production')
  assert.equal(production.hyperdrive[1].id, 'id-acme-hyperdrive-cached-production')
  assert.equal(production.vars.R2_ACCOUNT_ID, 'acct')
  // staging、顶层与其他字段保持原样，原对象不被修改
  assert.deepEqual(web.env.staging, configs.web.env.staging)
  assert.deepEqual(web.ratelimits, configs.web.ratelimits)
  assert.deepEqual(production.routes, configs.web.env.production.routes)
  assert.equal(configs.web.env.production.kv_namespaces[0].id.startsWith('0'.repeat(24)), true)
  // 已有账号 ID 不覆盖
  const pinned = template()
  const kept = applyResolution(
    pinned.web,
    'web',
    'staging',
    collectResources(pinned, 'staging').resources,
    {
      accountId: 'other',
    },
  )
  assert.equal(kept.env.staging.vars.R2_ACCOUNT_ID, '170a06d37ad50396b19943eb6b77a21d')
  assert.deepEqual(kept, pinned.web)
})

test('unresolved resources cannot be written into a deploy config', () => {
  const configs = generated()
  const { resources } = collectResources(configs, 'staging')
  assert.throws(() => applyResolution(configs.web, 'web', 'staging', resources), /尚未解析/)
})

test('missing env sections, rate-limit reuse and empty project vars are reported', () => {
  assert.throws(() => collectResources(template(), 'preview'), /env\.preview/)
  const configs = template()
  configs.web.env.production.ratelimits[0].namespace_id = '1002'
  assert.match(rateLimitConflicts(configs).join(), /1002 同时用于 web env\.staging RL_AUTH/)
  const missing = missingProjectVars(generated(), 'staging')
  assert.ok(missing.includes('web vars.AI_GATEWAY_ID'))
  assert.equal(missing.includes('web vars.APP_URL'), false)
})
