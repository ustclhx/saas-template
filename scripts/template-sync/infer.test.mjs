import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createProject, projectOptions } from '../create-project.mjs'
import { normalizeParams, paramsToArgs, readBaseRecord } from '../template-base.mjs'
import { cloneTemplate, generateAt } from './generate.mjs'
import { inferCommand, inferParams, runInfer } from './infer.mjs'

const params = normalizeParams({
  name: 'acme',
  url: 'https://acme.example',
  locale: 'zh',
  ai: ['text', 'video'],
  features: ['docs', 'blog'],
  oauth: ['github'],
  mediaProviders: ['fal'],
  billing: ['paypal'],
  multiTenant: true,
  turnstile: false,
})
const gitAt = (date, dir, ...args) =>
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    },
  ).trim()
const git = (dir, ...args) => gitAt('2026-10-19T12:00:00Z', dir, ...args)
async function files(dir, entries) {
  for (const [path, text] of Object.entries(entries)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
}
const generator = `import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
const out = args[args.indexOf('--output') + 1]
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(out)
for (const entry of readdirSync(root)) if (entry !== 'scripts') cpSync(join(root, entry), join(out, entry), { recursive: true })
writeFileSync(join(out, '.template-base.json'), 'excluded metadata')
`
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'template-infer-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const template = join(root, 'template')
  await mkdir(template)
  git(template, 'init', '--quiet', '--initial-branch=main')
  git(template, 'remote', 'add', 'origin', 'https://user:password@example.com/templates/base.git')
  const config = {
    app: { supportEmail: params['support-email'] },
    i18n: { enabled: params.i18n, defaultLocale: params.locale },
    marketing: { enabled: params.marketing },
    billing: { enabled: params['billing-enabled'], providers: params.billing },
    credits: { enabled: params['credits-enabled'] },
    auth: { oauth: params.oauth, turnstile: params.turnstile },
    tenancy: { multiTenant: params['multi-tenant'] },
    ai: {
      text: { enabled: true },
      image: false,
      video: true,
      mediaProviders: params['media-providers'],
    },
    features: Object.fromEntries(
      ['publicApi', 'blog', 'docs', 'waitlist', 'newsletter'].map((key) => [
        key,
        params.features.includes(key),
      ]),
    ),
  }
  await files(template, {
    'scripts/create-project.mjs': generator,
    'template.config.ts': `export default defineTemplateConfig(${JSON.stringify(config, null, 2)})\n`,
    'package.json': '{"name":"@acme/root"}\n',
    'apps/web/wrangler.jsonc': '{"vars":{"APP_URL":"https://acme.example"}}\n',
    '.github/workflows/deploy-staging.yml': 'name: staging\n',
    '.github/workflows/selfhost-publish.yml': `inputs:\n      namespace:\n        default: ${params['image-namespace']}\n`,
    'packages/db/migrations/meta/_journal.json': '{"entries":[{"tag":"0000_init"}]}\n',
    'app.txt': 'correct version\n',
  })
  const commit = (title) => {
    git(template, 'add', '--all')
    git(template, 'commit', '--quiet', '-m', title)
    return git(template, 'rev-parse', 'HEAD')
  }
  const first = commit('correct')
  git(template, 'tag', '-a', 'template-v0.2.0', '-m', 'release')
  const project = join(root, 'project')
  const clone = await cloneTemplate(template)
  try {
    await generateAt(clone, first, params, project)
  } finally {
    await clone.cleanup()
  }
  await rm(join(project, '.template-base.json'))
  await files(project, { 'project-only.md': 'not template\n'.repeat(100) })
  git(project, 'init', '--quiet', '--initial-branch=main')
  git(project, 'add', '--all')
  git(project, 'commit', '--quiet', '-m', 'generated')
  const initial = git(project, 'rev-parse', 'HEAD')
  return { root, template, project, first, initial, commit, config }
}
const options = (f, extra = {}) => ({
  project: f.project,
  template: f.template,
  log() {},
  ...extra,
})

test('recovers every parameter from the root tree with provenance and ignores later edits', async (t) => {
  const f = await fixture(t)
  await files(f.project, {
    'package.json': '{"name":"@different/root"}',
    'template.config.ts': 'not config',
  })
  git(f.project, 'add', '--all')
  git(f.project, 'commit', '--quiet', '-m', 'customization')
  const restored = inferParams(f.project, f.initial)
  // 功能配置只保存集合语义；生成器写出固定的功能键顺序。
  assert.deepEqual(restored.params, { ...params, features: ['blog', 'docs'] })
  assert.match(restored.sources.name, /:package.json$/)
  assert.match(restored.sources['media-providers'], /:template.config.ts$/)
  assert.equal(restored.sources.target.includes('deploy-staging'), true)
  assert.equal((await runInfer(options(f))).candidates[0].score, 0)
  assert.equal(existsSync(join(f.project, '.template-base.json')), false)
})

test('missing parameters require explicit overrides and never use current defaults', async (t) => {
  const f = await fixture(t)
  delete f.config.ai.mediaProviders
  await files(f.project, {
    'template.config.ts': `export default defineTemplateConfig(${JSON.stringify(f.config)})`,
  })
  git(f.project, 'add', '--all')
  git(f.project, 'commit', '--quiet', '--amend', '--no-edit')
  const root = git(f.project, 'rev-parse', 'HEAD')
  assert.throws(() => inferParams(f.project, root), /--param media-providers=/)
  await assert.rejects(
    runInfer(options(f, { template: join(f.root, 'does-not-exist') })),
    /--param media-providers=/,
  )
  const restored = inferParams(f.project, root, ['media-providers=fal,fal'])
  assert.deepEqual(restored.params['media-providers'], ['fal'])
  assert.equal(restored.sources['media-providers'], '--param')
  assert.throws(() => inferParams(f.project, root, ['turnstile=maybe']), /true 或 false/)
})

test('scores every main first-parent candidate and only writes an explicitly selected eligible SHA', async (t) => {
  const f = await fixture(t)
  git(f.template, 'tag', 'template-v9.0.0')
  const outOfWindow = await files(f.template, { 'app.txt': 'changed version\n' }).then(() =>
    f.commit('changed'),
  )
  git(f.template, 'switch', '--quiet', '-c', 'side')
  await files(f.template, { 'side.txt': 'side change\n' })
  const side = f.commit('side')
  git(f.template, 'switch', '--quiet', 'main')
  const logs = []
  const result = await runInfer(options(f, { log: (message) => logs.push(message) }))
  assert.equal(result.candidates.length, 2)
  assert.equal(result.candidates[0].commit, f.first)
  assert.equal(result.candidates[0].score, 0)
  assert.equal(result.candidates[1].commit, outOfWindow)
  assert.equal(result.candidates[1].score, 2)
  await assert.rejects(runInfer(options(f, { write: outOfWindow, threshold: 1 })), /超过 1/)
  assert.equal(
    (await runInfer(options(f, { since: '2026-10-19', until: '2026-10-19' }))).candidates.length,
    2,
  )
  assert.equal(
    result.candidates.some((candidate) => candidate.commit === side),
    false,
  )
  assert.deepEqual(result.candidates[0].projectOnly, ['project-only.md'])
  assert.match(logs.join('\n'), /分数=0/)
  assert.equal(Date.parse(result.until) - Date.parse(result.since), 6 * 86400000)
  await assert.rejects(runInfer(options(f, { write: side })), /完整 SHA/)
  const written = await runInfer(options(f, { write: f.first }))
  assert.equal(written.status, 'written')
  const record = await readBaseRecord(f.project)
  assert.equal(record.repository, 'https://example.com/templates/base')
  assert.equal(record.version, '0.2.0')
  assert.equal(record.clean, true)
  assert.deepEqual(record.migrations, ['0000_init'])
  assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.initial)
  assert.equal(git(f.project, 'status', '--porcelain'), '?? .template-base.json')
  assert.equal(
    (await readFile(join(f.project, '.template-base.json'), 'utf8')).includes(f.root),
    false,
  )
})

test('refuses selected candidate above 50 even when another candidate matches', async (t) => {
  const f = await fixture(t)
  await files(f.template, { 'app.txt': 'different\n'.repeat(51), 'new.txt': 'new\n' })
  const bad = f.commit('too different')
  const result = await runInfer(options(f))
  assert.equal(result.candidates[1].score, 53)
  await assert.rejects(runInfer(options(f, { write: bad })), /超过 50/)
  assert.equal(existsSync(join(f.project, '.template-base.json')), false)
  await assert.rejects(
    runInfer(options(f, { since: '2030-01-01', until: '2030-02-01' })),
    /没有 main 候选/,
  )
  await assert.rejects(inferCommand([]), /--project/)
})

test('date filtering traverses an out-of-window commit to find in-window ancestors', async (t) => {
  const f = await fixture(t)
  await files(f.template, { 'app.txt': 'older clock\n' })
  git(f.template, 'add', '--all')
  gitAt('2026-10-01T12:00:00Z', f.template, 'commit', '--quiet', '-m', 'older clock')
  await files(f.template, { 'app.txt': 'latest\n' })
  git(f.template, 'add', '--all')
  gitAt('2026-10-20T12:00:00Z', f.template, 'commit', '--quiet', '-m', 'latest')
  const result = await runInfer(options(f, { since: '2026-10-16', until: '2026-10-22' }))
  assert.equal(result.candidates.length, 2)
  assert.equal(result.candidates[0].commit, f.first)
  assert.equal(result.candidates[0].score, 0)
  assert.equal(result.candidates[1].title, 'latest')
})

test('real generator roundtrip recovers Cloudflare and selfhost parameters', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'template-infer-real-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const target of ['cloudflare', 'selfhost']) {
    const project = join(root, target)
    const expected = { ...params, features: ['blog', 'docs'], target }
    const args = paramsToArgs(expected)
    const input = Object.fromEntries(
      Array.from({ length: args.length / 2 }, (_, index) => [
        args[index * 2].slice(2),
        args[index * 2 + 1],
      ]),
    )
    await createProject(
      { ...input, output: project },
      fileURLToPath(new URL('../../', import.meta.url)),
    )
    git(project, 'init', '--quiet', '--initial-branch=main')
    git(project, 'add', '--all')
    git(project, 'commit', '--quiet', '-m', 'generated')
    assert.deepEqual(
      inferParams(project, git(project, 'rev-parse', 'HEAD')).params,
      normalizeParams(projectOptions(input)),
    )
  }
})

test('uses setup and example vars only as provenance-marked fallbacks', async (t) => {
  const f = await fixture(t)
  await rm(join(f.project, 'apps/web/wrangler.jsonc'))
  await rm(join(f.project, '.github/workflows'), { recursive: true })
  await files(f.project, {
    'PROJECT_SETUP.md': `# acme selfhost 初始化清单\nOCI namespace：${params['image-namespace']}；替换 owner\n`,
    '.dev.vars.example': 'APP_URL=https://acme.example\nSECRET=\n',
  })
  git(f.project, 'add', '--all')
  git(f.project, 'commit', '--quiet', '--amend', '--no-edit')
  const inferred = inferParams(f.project, git(f.project, 'rev-parse', 'HEAD'))
  assert.equal(inferred.params.target, 'selfhost')
  assert.match(inferred.sources['image-namespace'], /:PROJECT_SETUP.md$/)
  assert.match(inferred.sources.domain, /:.dev.vars.example$/)
})
