import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseArgs } from 'node:util'
import { projectOptions } from './create-project.mjs'
import {
  normalizeParams,
  paramsToArgs,
  readBaseRecord,
  serializeBaseRecord,
  sourceState,
  validateBaseRecord,
} from './template-base.mjs'

const minimalInput = { name: 'acme', domain: 'acme.example' }
const params = normalizeParams(projectOptions(minimalInput))
const baseline = {
  schemaVersion: 1,
  repository: 'https://github.com/example/template',
  commit: 'a'.repeat(40),
  version: null,
  clean: true,
  params,
  migrations: ['0000_initial'],
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'template-base-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

async function repository(t) {
  const directory = await fixture(t)
  git(directory, 'init', '--quiet')
  git(directory, 'config', 'user.name', 'Fixture')
  git(directory, 'config', 'user.email', 'fixture@example.test')
  git(directory, 'commit', '--quiet', '--allow-empty', '-m', 'initial')
  return directory
}

test('expanded defaults equal interactive answers and never retain output paths', () => {
  const explicit = projectOptions({
    ...minimalInput,
    domain: 'https://acme.example',
    output: '/tmp/unrecorded-local-path',
    target: 'cloudflare',
    locale: 'en',
    ai: 'text,image,video',
    'media-providers': 'fal,workers-ai',
    features: 'blog',
    billing: 'stripe,paypal',
    oauth: 'google,github',
    'billing-enabled': 'true',
    'credits-enabled': 'true',
    turnstile: 'true',
    'multi-tenant': 'false',
    marketing: 'true',
    i18n: 'true',
  })
  assert.deepEqual(normalizeParams(explicit), params)
  assert.deepEqual(Object.keys(params), Object.keys(params).sort())
  assert.equal(params['support-email'], 'support@acme.example')
  assert.equal(Object.hasOwn(params, 'output'), false)
  assert.equal(JSON.stringify(params).includes('/tmp/'), false)
})

test('normalized CLI arguments round-trip custom lists, flags, and empty lists', () => {
  const options = projectOptions({
    ...minimalInput,
    target: 'selfhost',
    locale: 'zh',
    ai: '',
    'media-providers': '',
    features: 'docs,publicApi',
    billing: '',
    oauth: 'github,google',
    'billing-enabled': 'false',
    'credits-enabled': 'false',
    'multi-tenant': 'true',
    marketing: 'false',
    i18n: 'false',
    turnstile: 'false',
    'image-namespace': 'ghcr.io/owner/custom',
  })
  const normalized = normalizeParams(options)
  const args = paramsToArgs(normalized)
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(Object.keys(normalized).map((key) => [key, { type: 'string' }])),
  })
  assert.deepEqual(normalizeParams(projectOptions(values)), normalized)
  assert.equal(args.includes('--skip-check'), false)
  assert.equal(args.includes('--output'), false)
})

test('normalization deduplicates each list without reordering or mutating input', () => {
  const options = projectOptions(minimalInput)
  options.ai = ['video', 'text', 'video', 'image']
  options.features = ['docs', 'blog', 'docs']
  options.oauth = ['github', 'github', 'google']
  options.billing = ['paypal', 'stripe', 'paypal']
  options.mediaProviders = ['workers-ai', 'fal', 'workers-ai']
  const normalized = normalizeParams(options)
  assert.deepEqual(normalized.ai, ['video', 'text', 'image'])
  assert.deepEqual(normalized.features, ['docs', 'blog'])
  assert.deepEqual(normalized.oauth, ['github', 'google'])
  assert.deepEqual(normalized.billing, ['paypal', 'stripe'])
  assert.deepEqual(normalized['media-providers'], ['workers-ai', 'fal'])
  assert.equal(options.ai.length, 4)
})

test('baseline serialization fixes field order and reads the validated record', async (t) => {
  const directory = await fixture(t)
  const record = { ...baseline, version: '0.2.0-rc.1+build.2' }
  const text = serializeBaseRecord(Object.fromEntries(Object.entries(record).reverse()))
  assert.equal(text, `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(join(directory, '.template-base.json'), text)
  assert.deepEqual(await readBaseRecord(directory), record)
  assert.deepEqual(
    validateBaseRecord({ ...record, repository: null, commit: null, version: null, clean: false }),
    { ...record, repository: null, commit: null, version: null, clean: false },
  )
})

test('baseline schema rejects malformed records and incomplete generation parameters', async (t) => {
  const invalid = [
    null,
    [],
    { ...baseline, schemaVersion: 2 },
    { ...baseline, extra: 'value' },
    { ...baseline, commit: 'abc123' },
    { ...baseline, commit: null },
    { ...baseline, version: 'v0.2.0' },
    { ...baseline, version: '1.0.0-01' },
    { ...baseline, clean: 'true' },
    { ...baseline, repository: 'https://token@github.com/example/template' },
    { ...baseline, repository: 'git@github.com:example/template.git' },
    { ...baseline, migrations: [1] },
    { ...baseline, params: { ...params, output: '/tmp/path' } },
    { ...baseline, params: { ...params, ai: ['invalid'] } },
    { ...baseline, params: { ...params, oauth: ['github', 'github'] } },
    { ...baseline, params: { ...params, turnstile: 'true' } },
    { ...baseline, params: { ...params, domain: 'https://user:pass@acme.example' } },
    { ...baseline, params: { ...params, domain: 'https://acme.example/path' } },
    { ...baseline, params: { ...params, 'billing-enabled': false } },
  ]
  const incomplete = structuredClone(baseline)
  delete incomplete.params.target
  invalid.push(incomplete)
  for (const record of invalid) assert.throws(() => validateBaseRecord(record), Error)
  const directory = await fixture(t)
  await assert.rejects(readBaseRecord(directory), { code: 'ENOENT' })
  await writeFile(join(directory, '.template-base.json'), '{')
  await assert.rejects(readBaseRecord(directory), SyntaxError)
})

test('source state strips origin credentials and does not expose git identity', async (t) => {
  const directory = await repository(t)
  const commit = git(directory, 'rev-parse', 'HEAD')
  for (const origin of [
    'git@github.com:example/template.git',
    'ssh://git@github.com/example/template.git/',
    'https://personal:secret@github.com/example/template.git/?token=secret#fragment',
    'https://github.com/example/template/',
  ]) {
    git(directory, 'config', 'remote.origin.url', origin)
    assert.deepEqual(sourceState(directory), {
      repository: 'https://github.com/example/template',
      commit,
      version: null,
      clean: true,
    })
  }
  git(directory, 'config', 'remote.origin.url', 'git@host:o/r.git')
  assert.equal(sourceState(directory).repository, 'https://host/o/r')
  assert.equal(
    validateBaseRecord({ ...baseline, repository: 'https://host/o/r' }).repository,
    'https://host/o/r',
  )
  git(directory, 'config', '--unset', 'remote.origin.url')
  assert.equal(sourceState(directory).repository, null)
  git(directory, 'config', 'status.showUntrackedFiles', 'no')
  await writeFile(join(directory, 'untracked'), 'changed')
  assert.equal(sourceState(directory).clean, false)
})

test('source version selects only valid exact template tags using SemVer precedence', async (t) => {
  const directory = await repository(t)
  const add = (version) => git(directory, 'tag', `template-v${version}`)
  git(directory, 'tag', 'v99.0.0')
  for (const version of [
    '2.0.0-01',
    '02.0.0',
    '1.0',
    '2.0.0-beta',
    '2.0.0-beta.9',
    '2.0.0-beta.10',
    '2.0.0-alpha.999',
  ])
    add(version)
  assert.equal(sourceState(directory).version, '2.0.0-beta.10')
  add('2.0.0')
  assert.equal(sourceState(directory).version, '2.0.0')
  add('2.0.0+A')
  add('2.0.0+z')
  assert.equal(sourceState(directory).version, '2.0.0+z')
  add('10.0.0')
  assert.equal(sourceState(directory).version, '10.0.0')
  add('99999999999999999999999999.0.0-rc.99999999999999999999')
  add('99999999999999999999999999.0.0-rc.100000000000000000000')
  assert.equal(
    sourceState(directory).version,
    '99999999999999999999999999.0.0-rc.100000000000000000000',
  )
  git(directory, 'commit', '--quiet', '--allow-empty', '-m', 'untagged')
  assert.equal(sourceState(directory).version, null)
})

test('archive directories and nested non-git directories never borrow a parent repository', async (t) => {
  const directory = await fixture(t)
  const empty = { repository: null, commit: null, version: null, clean: false }
  assert.deepEqual(sourceState(directory), empty)
  const parent = await repository(t)
  const nested = join(parent, 'archive')
  await mkdir(nested)
  assert.deepEqual(sourceState(nested), empty)
})

test('source state ignores caller git repository, index, and injected configuration', async (t) => {
  const directory = await repository(t)
  const other = await repository(t)
  git(directory, 'config', 'remote.origin.url', 'https://github.com/example/template')
  const keys = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  process.env.GIT_DIR = join(other, '.git')
  process.env.GIT_WORK_TREE = other
  process.env.GIT_INDEX_FILE = join(other, 'not-an-index')
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url'
  process.env.GIT_CONFIG_VALUE_0 = 'https://attacker.example/other'
  assert.equal(sourceState(directory).repository, 'https://github.com/example/template')
  assert.equal(sourceState(directory).clean, true)
})
