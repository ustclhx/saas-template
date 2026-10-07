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
    billing: { providers: ['stripe'] }, ai: { text: true, image: true, video: true },
    features: { blog: true },
  })`,
  )
  for (const app of ['web', 'jobs']) {
    await file(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}` }))
    await file(
      `apps/${app}/wrangler.jsonc`,
      JSON.stringify({
        name: app,
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
        workflows: [{ name: 'ai-media', script_name: 'jobs' }],
        queues: { producers: [{ queue: 'email' }] },
        env: { staging: { name: `${app}-staging`, vars: { APP_URL: 'https://old.workers.dev' } } },
      }),
    )
  }
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
  assert.doesNotMatch(result.report, /FAL_KEY|Workflow：|STRIPE_SECRET|GOOGLE_CLIENT/)
  const example = await readFile(join(result.target, '.dev.vars.example'), 'utf8')
  for (const line of example.split('\n').filter((line) => line && !line.startsWith('#'))) {
    assert.match(line, /^[A-Z_]+=$/)
  }
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
  const result = spawnSync(process.execPath, ['scripts/create-project', '--name', 'acme'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    input: '',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /非交互模式/)
})
