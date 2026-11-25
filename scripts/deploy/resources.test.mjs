import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEPLOY_CONFIG, parseArgs, run } from './resources.mjs'
import { fakeCloudflare, generatedTexts, wranglerText } from './test-fixtures.mjs'

const CREDS = { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' }
const SECRET_URL = 'postgres://app:s3cr3t-pass@db.example.com/saas_staging'

/** 在临时 Git 仓库中放入 wrangler 配置与本仓库的 .gitignore，并提交，便于检查工作树。 */
function repo(texts = { web: wranglerText('web'), jobs: wranglerText('jobs') }) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-resources-'))
  for (const app of ['web', 'jobs']) {
    mkdirSync(join(root, 'apps', app), { recursive: true })
    writeFileSync(join(root, 'apps', app, 'wrangler.jsonc'), texts[app])
  }
  copyFileSync(new URL('../../.gitignore', import.meta.url), join(root, '.gitignore'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  return { root, status: () => git('status', '--porcelain') }
}

async function exec(root, argv, { env = CREDS, fake } = {}) {
  const out = []
  const err = []
  const code = await run({
    root,
    argv,
    env,
    fetch: fake?.fetch ?? (() => assert.fail('unexpected fetch')),
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') }
}

const deployConfig = (root, app) =>
  JSON.parse(readFileSync(join(root, 'apps', app, DEPLOY_CONFIG), 'utf8'))
const creates = (fake) => fake.calls.filter((call) => call.method === 'POST')
const hyperdrives = (prefix, environment) => [
  { id: 'hd-plain', name: `${prefix}hyperdrive-${environment}` },
  { id: 'hd-cached', name: `${prefix}hyperdrive-cached-${environment}` },
]

test('arguments: --env is required and --create-hyperdrive needs --apply', () => {
  assert.deepEqual(parseArgs(['--env', 'staging', '--apply']).apply, true)
  assert.equal(parseArgs(['--', '--env=production']).env, 'production')
  assert.throws(() => parseArgs([]), /缺少 --env/)
  assert.throws(() => parseArgs(['--env', 'staging', '--force']), /未知参数/)
  assert.throws(() => parseArgs(['--env', 'staging', '--create-hyperdrive']), /--apply/)
})

test('fully pinned template staging makes no API call and needs no credentials', async () => {
  const { root, status } = repo()
  const result = await exec(root, ['--env', 'staging'], { env: {} })
  assert.equal(result.code, 0, result.all)
  assert.match(result.out, /KV CACHE\s+cache-staging\s+已固定\s+f4d49b7c082b4f01ae20335683d3a21b/)
  const web = deployConfig(root, 'web')
  assert.equal(web.env.staging.kv_namespaces[0].id, 'f4d49b7c082b4f01ae20335683d3a21b')
  assert.equal(web.env.staging.hyperdrive[1].id, 'ad4f2267382b427fbdd2ffe60d3a64de')
  assert.equal(
    deployConfig(root, 'jobs').env.staging.queues.consumers[1].dead_letter_queue,
    'events-dlq-staging',
  )
  assert.equal(status(), '')
  // --apply 同样不调用 API
  assert.equal((await exec(root, ['--env', 'staging', '--apply'], { env: {} })).code, 0)
})

test('new project plan lists what is missing and creates nothing', async () => {
  const { root, status } = repo(generatedTexts())
  const fake = fakeCloudflare()
  const result = await exec(root, ['--env', 'staging'], { fake })
  assert.equal(result.code, 1)
  assert.match(result.out, /KV CACHE\s+acme-cache-staging\s+待创建/)
  assert.match(result.out, /R2 acme-files-staging\s+acme-files-staging\s+待创建/)
  assert.match(result.out, /队列 acme-events-dlq-staging\s+acme-events-dlq-staging\s+待创建/)
  assert.match(result.out, /Hyperdrive HYPERDRIVE\s+acme-hyperdrive-staging\s+不能自动创建/)
  assert.match(result.err, /--apply/)
  assert.equal(creates(fake).length, 0)
  assert.equal(existsSync(join(root, 'apps', 'web', DEPLOY_CONFIG)), false)
  assert.equal(status(), '')
})

test('missing credentials explain the token permissions', async () => {
  const { root } = repo(generatedTexts())
  const result = await exec(root, ['--env', 'staging', '--apply'], { env: {} })
  assert.equal(result.code, 1)
  assert.match(result.out, /待查找（缺少凭据）/)
  assert.match(result.err, /Workers KV Storage Write/)
  assert.match(result.err, /Queues Write/)
  assert.match(result.err, /Hyperdrive Read/)
  assert.doesNotMatch(result.err, /Hyperdrive Write/)
})

test('first apply creates KV, R2 and queues in order, fails on Hyperdrive, then reruns cleanly', async () => {
  const { root, status } = repo(generatedTexts())
  const fake = fakeCloudflare()
  const first = await exec(root, ['--env', 'staging', '--apply'], { fake })
  assert.equal(first.code, 1)
  assert.deepEqual(
    creates(fake).map((call) => call.body.title ?? call.body.name ?? call.body.queue_name),
    [
      'acme-cache-staging',
      'acme-files-staging',
      'acme-events-dlq-staging',
      'acme-email-staging',
      'acme-events-staging',
    ],
  )
  assert.match(first.err, /Hyperdrive HYPERDRIVE：期望名称 acme-hyperdrive-staging/)
  assert.match(first.err, /--create-hyperdrive/)
  assert.equal(existsSync(join(root, 'apps', 'web', DEPLOY_CONFIG)), false)

  // 维护者在控制台建好 Hyperdrive 后重跑：沿用已建资源，不再创建
  fake.state.hyperdrive.push(...hyperdrives('acme-', 'staging'))
  const before = creates(fake).length
  const second = await exec(root, ['--env', 'staging', '--apply'], { fake })
  assert.equal(second.code, 0, second.all)
  assert.equal(creates(fake).length, before)
  assert.match(second.out, /KV CACHE\s+acme-cache-staging\s+按名称找到/)
  const kvId = fake.state.kv[0].id
  for (const app of ['web', 'jobs']) {
    const config = deployConfig(root, app)
    assert.equal(config.env.staging.kv_namespaces[0].id, kvId)
    assert.deepEqual(
      config.env.staging.hyperdrive.map((item) => item.id),
      ['hd-plain', 'hd-cached'],
    )
  }
  const web = deployConfig(root, 'web')
  assert.equal(web.env.staging.vars.R2_ACCOUNT_ID, 'acct')
  assert.equal(web.env.staging.vars.AI_GATEWAY_ACCOUNT_ID, 'acct')
  // 生成配置之外不改动任何已跟踪文件
  assert.equal(status(), '')
  assert.match(second.out, /env\.staging\.kv_namespaces: \[\{ "binding": "CACHE", "id": "/)
})

test('an interrupted apply resumes without creating duplicates', async () => {
  const { root } = repo(generatedTexts())
  const seed = { hyperdrive: hyperdrives('acme-', 'staging') }
  const broken = fakeCloudflare(seed, { failAfterCreates: 2 })
  const first = await exec(root, ['--env', 'staging', '--apply'], { fake: broken })
  assert.equal(first.code, 1)
  assert.match(first.err, /HTTP 500/)
  assert.match(first.err, /本次已创建（下次运行会沿用）：acme-cache-staging、acme-files-staging/)
  const fake = fakeCloudflare(broken.state)
  const second = await exec(root, ['--env', 'staging', '--apply'], { fake })
  assert.equal(second.code, 0, second.all)
  assert.deepEqual(
    creates(fake).map((call) => call.body.queue_name),
    ['acme-events-dlq-staging', 'acme-email-staging', 'acme-events-staging'],
  )
  for (const kind of ['kv', 'r2', 'queue']) {
    const names = fake.state[kind].map((item) => item.title ?? item.name ?? item.queue_name)
    assert.equal(new Set(names).size, names.length, kind)
  }
})

test('production never creates without --allow-production (template placeholders, task 1.5)', async () => {
  const { root, status } = repo()
  const fake = fakeCloudflare()
  const result = await exec(root, ['--env', 'production', '--apply'], { fake })
  assert.equal(result.code, 1)
  assert.equal(creates(fake).length, 0)
  assert.match(result.out, /模式：plan（production 未开启创建）/)
  assert.match(result.out, /KV CACHE\s+cache-production\s+待创建/)
  assert.match(
    result.out,
    /Hyperdrive HYPERDRIVE_CACHED\s+hyperdrive-cached-production\s+不能自动创建/,
  )
  assert.match(result.err, /--apply --allow-production/)
  assert.equal(status(), '')
})

test('production with a read-only token resolves complete resources without writes', async () => {
  const { root } = repo(generatedTexts())
  const seed = {
    kv: [{ id: 'kv-prod', title: 'acme-cache-production' }],
    r2: [{ name: 'acme-files-production' }],
    queue: ['email', 'events', 'events-dlq'].map((name) => ({
      queue_id: `q-${name}`,
      queue_name: `acme-${name}-production`,
    })),
    hyperdrive: hyperdrives('acme-', 'production'),
  }
  const fake = fakeCloudflare(seed, {
    deny: { 'kv:create': 403, 'r2:create': 403, 'queue:create': 403, 'hyperdrive:create': 403 },
  })
  const result = await exec(root, ['--env', 'production'], { fake })
  assert.equal(result.code, 0, result.all)
  assert.equal(creates(fake).length, 0)
  assert.equal(deployConfig(root, 'jobs').env.production.kv_namespaces[0].id, 'kv-prod')
})

test('--create-hyperdrive creates both configs and never prints the connection string', async () => {
  const { root } = repo(generatedTexts())
  const fake = fakeCloudflare()
  const env = { ...CREDS, HYPERDRIVE_APP_URL: SECRET_URL }
  const argv = ['--env', 'production', '--apply', '--allow-production', '--create-hyperdrive']
  const result = await exec(root, argv, { env, fake })
  assert.equal(result.code, 0, result.all)
  const bodies = creates(fake)
    .filter((call) => call.kind === 'hyperdrive')
    .map((call) => call.body)
  assert.deepEqual(
    bodies.map((body) => [body.name, body.caching]),
    [
      ['acme-hyperdrive-production', { disabled: true }],
      ['acme-hyperdrive-cached-production', { disabled: false, max_age: 60 }],
    ],
  )
  assert.equal(bodies[0].origin.password, 's3cr3t-pass')
  assert.doesNotMatch(result.all, /s3cr3t|db\.example/)
  for (const app of ['web', 'jobs'])
    assert.doesNotMatch(readFileSync(join(root, 'apps', app, DEPLOY_CONFIG), 'utf8'), /s3cr3t/)

  // 缺少连接串时在任何 API 调用前失败
  const missing = await exec(root, argv, { fake: fakeCloudflare() })
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HYPERDRIVE_APP_URL/)
})

test('a token without queue permission fails and writes no deploy config', async () => {
  const { root } = repo(generatedTexts())
  const fake = fakeCloudflare(
    { hyperdrive: hyperdrives('acme-', 'staging') },
    { deny: { 'queue:create': 403 } },
  )
  const result = await exec(root, ['--env', 'staging', '--apply'], { fake })
  assert.equal(result.code, 1)
  assert.match(result.err, /Queues 创建被拒绝（HTTP 403）：API 令牌缺少「Queues Write」权限/)
  assert.equal(existsSync(join(root, 'apps', 'jobs', DEPLOY_CONFIG)), false)
})

test('duplicate names stop the run and list every id', async () => {
  const { root } = repo(generatedTexts())
  const fake = fakeCloudflare({
    hyperdrive: [
      { id: 'dup-1', name: 'acme-hyperdrive-staging' },
      { id: 'dup-2', name: 'acme-hyperdrive-staging' },
    ],
  })
  const result = await exec(root, ['--env', 'staging', '--apply'], { fake })
  assert.equal(result.code, 1)
  assert.match(result.err, /acme-hyperdrive-staging 对应多个资源（dup-1、dup-2）/)
  assert.equal(creates(fake).length, 0)
})

test('--verify checks pinned ids and only warns about unconventional names', async () => {
  const { root } = repo()
  const seed = {
    kv: [{ id: 'f4d49b7c082b4f01ae20335683d3a21b', title: 'saas-staging-cache' }],
    r2: [{ name: 'files-staging' }],
    queue: ['email', 'events', 'events-dlq'].map((name) => ({
      queue_id: name,
      queue_name: `${name}-staging`,
    })),
    hyperdrive: [{ id: 'b3a797e705e849a196a4f7fcaf887293', name: 'saas-staging-neon' }],
  }
  const result = await exec(root, ['--env', 'staging', '--verify'], { fake: fakeCloudflare(seed) })
  assert.equal(result.code, 1)
  assert.match(result.out, /实际名称 saas-staging-cache 与约定名称 cache-staging 不一致/)
  assert.match(result.err, /ad4f2267382b427fbdd2ffe60d3a64de 在账号中不存在/)
})

test('rate limit reuse and mismatched pinned ids are configuration errors', async () => {
  const texts = { web: wranglerText('web'), jobs: wranglerText('jobs') }
  const reused = repo({
    ...texts,
    web: texts.web.replace('"namespace_id": "1007"', '"namespace_id": "1002"'),
  })
  assert.match((await exec(reused.root, ['--env', 'staging'])).err, /namespace_id 1002/)
  const split = repo({
    ...texts,
    jobs: texts.jobs.replace(
      'f4d49b7c082b4f01ae20335683d3a21b',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
  })
  const result = await exec(split.root, ['--env', 'staging'])
  assert.equal(result.code, 1)
  assert.match(result.err, /不同的 ID/)
})
