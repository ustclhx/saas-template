import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { createProject, projectOptions } from './create-project.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bootstrap-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source')
  async function file(path, content) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    await writeFile(join(source, path), content)
  }
  await file('package.json', JSON.stringify({ name: 'fixture-template' }))
  await file('packages/config/package.json', JSON.stringify({ name: '@fixture/config' }))
  await file(
    'template.config.ts',
    `export default defineTemplateConfig({
    app: { name: 'FixtureApp', url: 'https://fixture.example', supportEmail: 'support@fixture.example' },
    i18n: { locales: ['en', 'zh'], defaultLocale: 'en' },
    tenancy: { multiTenant: false }, auth: { oauth: ['google'], turnstile: true },
    billing: { providers: ['stripe'] }, ai: { text: true, image: true, video: true, mediaProviders: ['fal', 'workers-ai'] },
    features: { blog: true },
  })`,
  )
  for (const app of ['web', 'jobs']) {
    await file(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}` }))
    await file(
      `apps/${app}/wrangler.jsonc`,
      JSON.stringify({
        name: app,
        ai: { binding: 'AI' },
        r2_buckets: [{ binding: 'FILES', bucket_name: 'files' }],
        vars: { R2_FILES_BUCKET: 'files' },
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
        workflows: [{ name: 'ai-media', script_name: 'jobs' }],
        queues: { producers: [{ queue: 'email' }] },
        env: {
          staging: {
            name: `${app}-staging`,
            ai: { binding: 'AI' },
            r2_buckets: [{ binding: 'FILES', bucket_name: 'files-staging' }],
            vars: {
              APP_URL: 'https://old.workers.dev',
              R2_FILES_BUCKET: 'files-staging',
              R2_ACCOUNT_ID: 'template-account',
              AI_GATEWAY_ACCOUNT_ID: 'template-account',
              AI_GATEWAY_ID: 'template-gateway',
            },
          },
        },
      }),
    )
  }
  await file(
    'apps/jobs/src/index.ts',
    "const EMAIL_QUEUES = new Set(['email', 'email-staging'])\nconst EVENTS_QUEUES = new Set(['events', 'events-staging'])",
  )
  await file('apps/jobs/test/queues.test.ts', "const queues = ['email', 'events-staging']")
  await file(
    '.github/workflows/deploy-staging.yml',
    'env:\n  STAGING_URL: https://old.workers.dev\n',
  )
  await file(
    'scripts/staging/files-cors.json',
    '{"origins":["https://web-staging.old.workers.dev"]}',
  )
  return {
    dir,
    source,
    file,
    input: { name: 'acme', domain: 'acme.example', target: join(dir, 'acme') },
  }
}

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
      ),
    )
  ).flat()
}

test('生成副本改名与配置，排除各级密钥、链接和产物', async (t) => {
  const f = await fixture(t)
  for (const path of [
    '.git/config',
    '.dev.vars',
    '.dev.vars.staging',
    '.env.local',
    '.env.worktree',
    'apps/web/.dev.vars',
    'apps/jobs/.env.production',
    'node_modules/secret',
    '.wrangler/state/data',
    'apps/web/dist/out',
    '.turbo/cache',
    'coverage/out',
    'openspec/changes/pending/tasks.md',
    'scripts/probes/x/results/config.json',
  ]) {
    await f.file(path, 'SENSITIVE_SENTINEL')
  }
  await f.file(
    'docs/fixture-template.md',
    'fixture-template FixtureApp @fixture/config fixture_dev',
  )
  await f.file('assets/icon.bin', Buffer.from([255, 216, 255]))
  await f.file('infra/.env.example', 'PASSWORD=\n')
  const external = join(f.dir, 'secret.txt')
  await writeFile(external, 'SENSITIVE_SENTINEL')
  await symlink(external, join(f.source, 'linked-secret'))
  const result = await createProject(
    {
      ...f.input,
      locale: 'zh',
      ai: 'text',
      features: 'waitlist,newsletter',
      billing: '',
      oauth: '',
      turnstile: 'false',
    },
    f.source,
  )
  const generated = await files(result.target)
  for (const path of generated) {
    assert.doesNotMatch(path, /fixture-template/)
    const content = await readFile(path)
    if (!content.includes(0)) {
      assert.doesNotMatch(
        content.toString(),
        /fixture-template|FixtureApp|@fixture\/|SENSITIVE_SENTINEL/,
      )
    }
  }
  assert.deepEqual(
    await readFile(join(result.target, 'assets/icon.bin')),
    Buffer.from([255, 216, 255]),
  )
  const config = await readFile(join(result.target, 'template.config.ts'), 'utf8')
  assert.match(config, /defaultLocale: 'zh'/)
  assert.match(config, /image: false/)
  assert.match(config, /"waitlist":true/)
  const wrangler = JSON.parse(
    await readFile(join(result.target, 'apps/web/wrangler.jsonc'), 'utf8'),
  )
  assert.equal(wrangler.name, 'acme-web')
  assert.equal(wrangler.hyperdrive[0].id, '00000000000000000000000000000000')
  assert.equal(wrangler.env.staging.vars.APP_URL, 'https://acme.example')
  assert.equal(wrangler.workflows, undefined)
  assert.equal(wrangler.ai, undefined)
  assert.equal(wrangler.env.staging.ai, undefined)
  for (const [env, bucket] of [
    [wrangler, 'acme-files'],
    [wrangler.env.staging, 'acme-files-staging'],
  ]) {
    assert.equal(env.r2_buckets[0].bucket_name, bucket)
    assert.equal(env.vars.R2_FILES_BUCKET, bucket)
  }
  for (const key of ['R2_ACCOUNT_ID', 'AI_GATEWAY_ACCOUNT_ID', 'AI_GATEWAY_ID']) {
    assert.equal(wrangler.env.staging.vars[key], '')
  }
  assert.match(result.report, /R2：FILES 私有桶 acme-files/)
  assert.match(result.report, /SENTRY_DSN/)
  assert.match(result.report, /SENTRY_AUTH_TOKEN/)
  assert.match(result.report, /RL_API/)
  assert.doesNotMatch(result.report, /R2_SECRET_ACCESS_KEY/)
  const worker = await readFile(join(result.target, 'apps/jobs/src/index.ts'), 'utf8')
  assert.match(worker, /new Set\(\['acme-email', 'acme-email-staging'\]\)/)
  assert.match(worker, /new Set\(\['acme-events', 'acme-events-staging'\]\)/)
  const queueFixtures = await readFile(join(result.target, 'apps/jobs/test/queues.test.ts'), 'utf8')
  assert.match(queueFixtures, /\['acme-email', 'acme-events-staging'\]/)
  const ci = await readFile(join(result.target, '.github/workflows/deploy-staging.yml'), 'utf8')
  assert.match(ci, /STAGING_URL: https:\/\/configure-staging-url\.invalid/)
  assert.doesNotMatch(ci, /old\.workers\.dev/)
  assert.equal(
    JSON.parse(await readFile(join(result.target, 'scripts/staging/files-cors.json'), 'utf8'))
      .origins[0],
    'https://acme.example',
  )
  assert.doesNotMatch(result.report, /FAL_KEY|Workflow：|STRIPE_SECRET|GOOGLE_CLIENT/)
  const example = await readFile(join(result.target, '.dev.vars.example'), 'utf8')
  for (const line of example.split('\n').filter((line) => line && !line.startsWith('#'))) {
    assert.match(line, /^[A-Z_]+=$/)
  }
  assert.match(example, /SENTRY_DSN=\n/)
  assert.doesNotMatch(
    example,
    /SENTRY_AUTH_TOKEN|SENTRY_ORG|SENTRY_PROJECT|STAGING_MIGRATION_DATABASE_URL/,
  )
  // 生成的模板也可以继续作为源，不依赖未加引号的对象键。
  await createProject({ ...f.input, name: 'next', target: join(f.dir, 'next') }, result.target)
})

test('媒体功能与支付开启时，清单和 Worker 引用同步生成', async (t) => {
  const f = await fixture(t)
  const result = await createProject(f.input, f.source)
  const wrangler = JSON.parse(
    await readFile(join(result.target, 'apps/web/wrangler.jsonc'), 'utf8'),
  )
  assert.equal(wrangler.workflows[0].name, 'acme-ai-media')
  assert.equal(wrangler.workflows[0].script_name, 'acme-jobs')
  assert.match(result.report, /FAL_KEY/)
  assert.match(result.report, /R2_SECRET_ACCESS_KEY/)
  assert.match(result.report, /STRIPE_WEBHOOK_SECRET/)
  assert.match(result.report, /GOOGLE_CLIENT_SECRET/)
})

test('拒绝覆盖、源树递归复制、非法名称和无效功能输入', async (t) => {
  const f = await fixture(t)
  await assert.rejects(createProject({ ...f.input, target: f.source }, f.source), /模板目录内/)
  await assert.rejects(
    createProject({ ...f.input, target: join(f.source, 'child') }, f.source),
    /模板目录内/,
  )
  await assert.rejects(
    createProject({ ...f.input, target: join(f.source, '..hidden') }, f.source),
    /模板目录内/,
  )
  assert.equal(
    projectOptions({ ...f.input, target: undefined }).target,
    resolve('..', f.input.name),
  )
  await mkdir(f.input.target)
  await assert.rejects(createProject(f.input, f.source), /目标已存在/)
  assert.throws(() => projectOptions({ ...f.input, name: '../escape' }), /名称/)
  assert.throws(() => projectOptions({ ...f.input, domain: 'acme.example/path' }), /域名/)
  assert.throws(() => projectOptions({ ...f.input, features: 'unknown' }), /features/)
  assert.throws(
    () => projectOptions({ ...f.input, 'media-providers': 'unknown' }),
    /media-providers/,
  )
  assert.throws(
    () => projectOptions({ ...f.input, 'media-providers': 'fal,fal' }),
    /media-providers/,
  )
  const result = spawnSync(process.execPath, ['scripts/create-project', '--name', 'acme'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    input: '',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /非交互模式/)
})

for (const providers of ['fal', 'workers-ai', '']) {
  test(`媒体服务商 ${providers || 'empty'} 的配置、密钥和所有环境绑定一致`, async (t) => {
    const f = await fixture(t)
    const result = await createProject({ ...f.input, 'media-providers': providers }, f.source)
    const config = await readFile(join(result.target, 'template.config.ts'), 'utf8')
    const list = providers ? providers.split(',') : []
    assert.ok(config.includes(`mediaProviders: ${JSON.stringify(list)}`))
    const example = await readFile(join(result.target, '.dev.vars.example'), 'utf8')
    assert.equal(example.includes('FAL_KEY='), list.includes('fal'))
    assert.equal(example.includes('MEDIA_WEBHOOK_SECRET='), list.includes('fal'))
    assert.equal(result.report.includes('fal.ai 账号'), list.includes('fal'))
    assert.equal(result.report.includes('Workers AI：'), list.includes('workers-ai'))
    assert.doesNotMatch(example, /(?:^|\n)AI=/)
    for (const app of ['web', 'jobs']) {
      const wrangler = JSON.parse(
        await readFile(join(result.target, 'apps', app, 'wrangler.jsonc'), 'utf8'),
      )
      for (const env of [wrangler, wrangler.env.staging]) {
        assert.deepEqual(env.ai, list.includes('workers-ai') ? { binding: 'AI' } : undefined)
      }
    }
  })
}
