import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { projectOptions } from './create-project.mjs'
import { normalizeParams, readBaseRecord, serializeBaseRecord } from './template-base.mjs'
import { cloneTemplate, generateAt } from './template-sync/generate.mjs'
import { diffLockPackages } from './template-sync/report.mjs'
import { PreflightError, runSync } from './template-sync.mjs'

const params = normalizeParams(projectOptions({ name: 'acme', domain: 'acme.example' }))
const identity = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com']

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...identity, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

// 假模板的生成器桩：只接受给定的参数名，按 name 改写 @saas/ 作用域与 Worker 名。
function generatorStub(optionNames) {
  return `import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
const names = ${JSON.stringify(optionNames)}
const { values } = parseArgs({
  options: Object.fromEntries([...names.map((n) => [n, { type: 'string' }]), ['output', { type: 'string' }], ['skip-check', { type: 'boolean' }]]),
})
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rename = (text) => text.replaceAll('@saas/', '@' + values.name + '/').replaceAll('saas-worker', values.name + '-worker')
function copy(rel) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel ? rel + '/' + entry.name : entry.name
    if (path === 'setup.txt') continue
    if (entry.isDirectory()) { mkdirSync(join(values.output, path), { recursive: true }); copy(path) }
    else writeFileSync(join(values.output, path), rename(readFileSync(join(root, path), 'utf8')))
  }
}
mkdirSync(values.output, { recursive: true })
copy('')
writeFileSync(join(values.output, 'PROJECT_SETUP.md'), '# ' + values.name + '\\n' + readFileSync(join(root, 'setup.txt'), 'utf8'))
`
}
const allOptions = Object.keys(params)

const journal = (tags) =>
  `${JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({
        idx,
        version: '7',
        when: 1000 + idx,
        tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  )}\n`
const snapshot = (id, prevId) =>
  `${JSON.stringify({ id, prevId, version: '7', dialect: 'postgresql', tables: {} }, null, 2)}\n`

const paragraphs = (first, second = 'Second paragraph stays the same.') =>
  `# Guide\n\n${first}\n\nMiddle line one.\nMiddle line two.\nMiddle line three.\nMiddle line four.\n\n${second}\n`
const wrangler = (extra = '') =>
  `{\n  "name": "saas-worker",\n  "hyperdrive": [\n    { "binding": "HYPERDRIVE", "id": "REPLACE_WITH_HYPERDRIVE_ID" }\n  ],\n  "compatibility_date": "2026-10-01",\n  "observability": { "enabled": true },\n  "limits": { "cpu_ms": 100 },\n  "placement": { "mode": "smart" },\n  "vars": {\n    "APP_URL": "https://example.com"${extra}\n  }\n}\n`

/** Files of the first fake template commit; later commits patch this map. */
function initialFiles() {
  return {
    'scripts/create-project.mjs': generatorStub(allOptions),
    'package.json': '{ "name": "@saas/root", "private": true }\n',
    'packages/db/package.json': '{ "name": "@saas/db" }\n',
    'src/app.ts': "import { core } from '@saas/core'\n\nexport const app = core('v1')\n",
    'docs/guide.md': paragraphs('First paragraph from the template.'),
    'legacy.txt': 'legacy notes\n',
    'wrangler.jsonc': wrangler(),
    'setup.txt': '- [ ] configure hyperdrive\n',
    'pnpm-lock.yaml':
      "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.0.0:\n    resolution: {}\n",
    'packages/db/migrations/0000_init.sql': 'CREATE TABLE "a" (id int);\n',
    'packages/db/migrations/meta/_journal.json': journal(['0000_init']),
    'packages/db/migrations/meta/0000_snapshot.json': snapshot(
      'snap-0',
      '00000000-0000-0000-0000-000000000000',
    ),
  }
}

async function scratch(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(root, path), { force: true })
      continue
    }
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function fakeTemplate(t) {
  const dir = await scratch(t, 'template-sync-template-')
  git(dir, 'init', '--quiet', '--initial-branch=main')
  const commit = async (files, message, tag) => {
    await writeFiles(dir, files)
    git(dir, 'add', '--all')
    git(dir, 'commit', '--quiet', '-m', message)
    if (tag) git(dir, 'tag', '-a', tag, '-m', tag)
    return git(dir, 'rev-parse', 'HEAD')
  }
  const first = await commit(initialFiles(), 'initial')
  return { dir, commit, first }
}

async function fakeProject(t, template, commit = template.first, record = {}) {
  const parent = await scratch(t, 'template-sync-project-')
  const dir = join(parent, 'acme')
  const clone = await cloneTemplate(template.dir)
  try {
    await generateAt(clone, commit, params, dir)
  } finally {
    await clone.cleanup()
  }
  await writeFile(
    join(dir, '.template-base.json'),
    serializeBaseRecord({
      schemaVersion: 1,
      repository: 'https://example.com/acme/template',
      commit,
      version: null,
      clean: true,
      params,
      migrations: ['0000_init'],
      ...record,
    }),
  )
  git(dir, 'init', '--quiet', '--initial-branch=main')
  // 同步工具用项目自身的 Git 身份提交；CI runner 没有全局身份。
  git(dir, 'config', 'user.name', 'fixture')
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'add', '--all')
  git(dir, 'commit', '--quiet', '-m', 'generated')
  const change = async (files, message) => {
    await writeFiles(dir, files)
    git(dir, 'add', '--all')
    git(dir, 'commit', '--quiet', '-m', message)
  }
  return { dir, change }
}

/** Stub for pnpm: records calls, fakes drizzle-kit output and can fail chosen commands. */
function stubRunner({ fail = [], generatedSnapshot = null, lockAfterInstall = null } = {}) {
  const calls = []
  let generated = 0
  const runner = (command, args, { cwd }) => {
    const label = [command, ...args].join(' ')
    calls.push(label)
    if (args.includes('drizzle-kit')) {
      // 第一次 generate 模拟合并后 schema 产生的新 snapshot，之后模拟「无变化」。
      const config = readFileSync(args[args.indexOf('--config') + 1], 'utf8')
      const out = resolve(cwd, 'packages/db', JSON.parse(config.match(/out: ("[^"]*")/)[1]))
      if (generatedSnapshot && generated++ === 0) {
        writeFileSync(join(out, 'meta/9999_snapshot.json'), JSON.stringify(generatedSnapshot))
        return { status: 0, output: '[✓] Your SQL migration file' }
      }
      return { status: 0, output: 'No schema changes, nothing to migrate' }
    }
    if (lockAfterInstall && label === 'pnpm install --no-frozen-lockfile') {
      writeFileSync(join(cwd, 'pnpm-lock.yaml'), lockAfterInstall)
    }
    const failing = fail.includes(label)
    return { status: failing ? 1 : 0, output: failing ? `${label} failed` : 'ok' }
  }
  return { runner, calls }
}

const quiet = () => {}

async function branches(dir) {
  return git(dir, 'branch', '--format=%(refname:short)').split('\n').sort()
}

test('preflight refuses a missing baseline and points to infer-base without creating a branch', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit({ 'src/app.ts': "export const app = 'v2'\n" }, 'change')
  await rm(join(project.dir, '.template-base.json'))
  git(project.dir, 'commit', '--quiet', '-am', 'drop record')
  const head = git(project.dir, 'rev-parse', 'HEAD')
  await assert.rejects(
    runSync({ project: project.dir, template: template.dir, log: quiet }),
    (error) => error instanceof PreflightError && /infer-base/.test(error.message),
  )
  assert.deepEqual(await branches(project.dir), ['main'])
  assert.equal(git(project.dir, 'rev-parse', 'HEAD'), head)
})

test('preflight refuses an unclean baseline record', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template, template.first, { clean: false })
  await template.commit({ 'src/app.ts': "export const app = 'v2'\n" }, 'change')
  await assert.rejects(
    runSync({ project: project.dir, template: template.dir, log: quiet }),
    (error) => error instanceof PreflightError && /clean=false/.test(error.message),
  )
  assert.deepEqual(await branches(project.dir), ['main'])
})

test('preflight refuses a dirty working tree and keeps the uncommitted change', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit({ 'src/app.ts': "export const app = 'v2'\n" }, 'change')
  await writeFile(join(project.dir, 'notes.txt'), 'draft\n')
  await assert.rejects(
    runSync({ project: project.dir, template: template.dir, log: quiet }),
    (error) => error instanceof PreflightError && /未提交/.test(error.message),
  )
  assert.deepEqual(await branches(project.dir), ['main'])
  assert.equal(await readFile(join(project.dir, 'notes.txt'), 'utf8'), 'draft\n')
})

test('already up to date reports no update and leaves the project untouched', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  const messages = []
  const result = await runSync({
    project: project.dir,
    template: template.dir,
    log: (message) => messages.push(message),
  })
  assert.equal(result.status, 'up-to-date')
  assert.match(messages.join('\n'), /已是最新/)
  assert.deepEqual(await branches(project.dir), ['main'])
  assert.equal(git(project.dir, 'status', '--porcelain'), '')
})

test('a generator that rejects a recorded parameter stops with the parameter and commit', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  const target = await template.commit(
    {
      'scripts/create-project.mjs': generatorStub(
        allOptions.filter((name) => name !== 'multi-tenant'),
      ),
    },
    'drop option',
  )
  await assert.rejects(
    runSync({ project: project.dir, template: template.dir, log: quiet }),
    (error) =>
      error instanceof PreflightError &&
      error.message.includes('--multi-tenant') &&
      error.message.includes(target),
  )
  assert.deepEqual(await branches(project.dir), ['main'])
})

test('clean sync applies renamed changes, keeps project values, ports migrations and updates the baseline', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await project.change(
    {
      'wrangler.jsonc': wrangler().replace('REPLACE_WITH_HYPERDRIVE_ID', 'real-hyperdrive-id-123'),
      'packages/db/migrations/0001_own.sql': 'CREATE TABLE "own" (id int);\n',
      'packages/db/migrations/meta/_journal.json': journal(['0000_init', '0001_own']).replace(
        '"when": 1001',
        '"when": 5000',
      ),
      'packages/db/migrations/meta/0001_snapshot.json': snapshot('snap-own', 'snap-0'),
    },
    'project: real id and own migration',
  )
  const mainHead = git(project.dir, 'rev-parse', 'HEAD')
  const target = await template.commit(
    {
      'src/feature.ts':
        "import { core } from '@saas/core'\nexport const feature = core('saas-worker')\n",
      // 改动紧邻项目填写的 ID（在上下文范围内），只能经三方合并应用。
      'wrangler.jsonc': wrangler(',\n    "NEW_BINDING": "on"').replace('2026-10-01', '2026-10-20'),
      'package.json':
        '{ "name": "@saas/root", "private": true, "dependencies": { "left-pad": "^1.1.0" } }\n',
      'setup.txt': '- [ ] configure hyperdrive\n- [ ] configure queues\n',
      'packages/db/migrations/0001_feature.sql': 'CREATE TABLE "feature" (id int);\n',
      'packages/db/migrations/meta/_journal.json': journal(['0000_init', '0001_feature']),
      'packages/db/migrations/meta/0001_snapshot.json': snapshot('tpl-1', 'snap-0'),
    },
    'feature',
    'template-v0.2.0',
  )
  const { runner, calls } = stubRunner({
    generatedSnapshot: { id: 'generated', prevId: 'whatever', tables: { feature: {} } },
    lockAfterInstall:
      "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.1.0:\n    resolution: {}\n",
  })
  const result = await runSync({ project: project.dir, template: template.dir, runner, log: quiet })
  assert.equal(result.status, 'synced')
  assert.equal(result.branch, `template-sync/${target.slice(0, 12)}`)
  assert.equal(git(project.dir, 'rev-parse', 'main'), mainHead)
  assert.equal(git(project.dir, 'status', '--porcelain'), '')

  const feature = await readFile(join(project.dir, 'src/feature.ts'), 'utf8')
  assert.match(feature, /@acme\/core/)
  assert.match(feature, /acme-worker/)
  const config = await readFile(join(project.dir, 'wrangler.jsonc'), 'utf8')
  assert.match(config, /real-hyperdrive-id-123/)
  assert.match(config, /NEW_BINDING/)
  assert.match(config, /2026-10-20/)
  assert.equal(
    await readFile(join(project.dir, 'PROJECT_SETUP.md'), 'utf8'),
    '# acme\n- [ ] configure hyperdrive\n',
  )
  assert.match(result.report.setupDiff, /\+- \[ \] configure queues/)
  assert.deepEqual(result.report.lockChanges, [
    { name: 'left-pad', before: ['1.0.0'], after: ['1.1.0'] },
  ])

  const projectJournal = JSON.parse(
    await readFile(join(project.dir, 'packages/db/migrations/meta/_journal.json'), 'utf8'),
  )
  assert.deepEqual(
    projectJournal.entries.map((entry) => [entry.idx, entry.tag, entry.when]),
    [
      [0, '0000_init', 1000],
      [1, '0001_own', 5000],
      [2, '0002_tpl_feature', 5001],
    ],
  )
  assert.equal(
    await readFile(join(project.dir, 'packages/db/migrations/0002_tpl_feature.sql'), 'utf8'),
    'CREATE TABLE "feature" (id int);\n',
  )
  const finalSnapshot = JSON.parse(
    await readFile(join(project.dir, 'packages/db/migrations/meta/0002_snapshot.json'), 'utf8'),
  )
  assert.deepEqual(finalSnapshot.tables, { feature: {} })
  assert.equal(finalSnapshot.prevId, 'snap-own')
  assert.notEqual(finalSnapshot.id, 'generated')

  const record = await readBaseRecord(project.dir)
  assert.equal(record.commit, target)
  assert.equal(record.version, '0.2.0')
  assert.deepEqual(record.migrations, ['0000_init', '0001_feature'])
  assert.deepEqual(git(project.dir, 'log', '--format=%s', 'main..HEAD').split('\n'), [
    `chore(template-sync): 更新模板基准到 ${target.slice(0, 12)}`,
    `chore(template-sync): 采纳模板 ${template.first.slice(0, 12)}..${target.slice(0, 12)}`,
  ])
  assert.deepEqual(
    calls.filter((call) => !call.includes('drizzle-kit')),
    [
      'pnpm install --no-frozen-lockfile',
      'pnpm install --frozen-lockfile',
      'pnpm exec biome format --write packages/db/migrations/meta',
      'pnpm typecheck',
      'pnpm test',
    ],
  )
  assert.equal(calls.filter((call) => call.includes('drizzle-kit generate')).length, 2)
  assert.ok(result.reportPath.startsWith(git(project.dir, 'rev-parse', '--absolute-git-dir')))
  const report = await readFile(result.reportPath, 'utf8')
  assert.match(report, /`0001_feature` → `0002_tpl_feature`/)
  assert.match(report, /类型检查：通过/)

  // 再次同步：只移植新增的模板迁移，已登记的不重复追加。
  git(project.dir, 'switch', '--quiet', 'main')
  git(project.dir, 'merge', '--quiet', '--ff-only', result.branch)
  const next = await template.commit(
    {
      'packages/db/migrations/0002_more.sql': 'CREATE TABLE "more" (id int);\n',
      'packages/db/migrations/meta/_journal.json': journal([
        '0000_init',
        '0001_feature',
        '0002_more',
      ]),
    },
    'more',
  )
  const again = await runSync({
    project: project.dir,
    template: template.dir,
    to: 'HEAD',
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(again.status, 'synced')
  assert.deepEqual(
    again.report.ported.map((item) => [item.source, item.tag]),
    [['0002_more', '0003_tpl_more']],
  )
  const after = await readBaseRecord(project.dir)
  assert.equal(after.commit, next)
  assert.equal(after.version, null)
  assert.deepEqual(after.migrations, ['0000_init', '0001_feature', '0002_more'])
  assert.match(await readFile(again.reportPath, 'utf8'), /目标未发布/)
})

test('conflicts keep markers on the sync branch, list every file and leave the baseline unchanged', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await project.change(
    {
      'docs/guide.md': paragraphs('First paragraph rewritten by the project.'),
      'legacy.txt': 'legacy notes\nproject addition\n',
    },
    'project edits',
  )
  const mainHead = git(project.dir, 'rev-parse', 'HEAD')
  await template.commit(
    {
      'docs/guide.md': paragraphs(
        'First paragraph rewritten by the template.',
        'Second paragraph updated by the template.',
      ),
      'legacy.txt': null,
      'src/app.ts': "import { core } from '@saas/core'\n\nexport const app = core('v2')\n",
      'packages/db/migrations/0001_feature.sql': 'CREATE TABLE "feature" (id int);\n',
      'packages/db/migrations/meta/_journal.json': journal(['0000_init', '0001_feature']),
    },
    'template edits',
  )
  const { runner, calls } = stubRunner()
  const result = await runSync({ project: project.dir, template: template.dir, runner, log: quiet })
  assert.equal(result.status, 'conflicts')
  assert.deepEqual(result.report.conflicts.map((item) => item.path).sort(), [
    'docs/guide.md',
    'legacy.txt',
  ])
  const guide = await readFile(join(project.dir, 'docs/guide.md'), 'utf8')
  assert.match(
    guide,
    /<<<<<<<[\s\S]*rewritten by the project[\s\S]*=======[\s\S]*rewritten by the template[\s\S]*>>>>>>>/,
  )
  assert.equal(
    await readFile(join(project.dir, 'legacy.txt'), 'utf8'),
    'legacy notes\nproject addition\n',
  )
  assert.match(await readFile(join(project.dir, 'src/app.ts'), 'utf8'), /core\('v2'\)/)
  assert.equal(git(project.dir, 'branch', '--show-current'), result.branch)
  assert.equal(git(project.dir, 'rev-parse', 'HEAD'), mainHead)
  assert.equal(git(project.dir, 'rev-parse', 'main'), mainHead)
  assert.equal((await readBaseRecord(project.dir)).commit, template.first)
  assert.equal(existsSync(join(project.dir, 'packages/db/migrations/0001_tpl_feature.sql')), false)
  assert.deepEqual(calls, [])
  const report = await readFile(result.reportPath, 'utf8')
  assert.match(report, /`docs\/guide.md`：三方合并冲突/)
  assert.match(report, /`legacy.txt`：模板删除了该文件，项目改过它/)
})

test('a template edit to a file the project deleted is a named conflict, not a git error', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await project.change({ 'legacy.txt': null }, 'project removes legacy notes')
  await template.commit({ 'legacy.txt': 'legacy notes\ntemplate addition\n' }, 'template edit')
  const { runner } = stubRunner()
  const result = await runSync({ project: project.dir, template: template.dir, runner, log: quiet })
  assert.equal(result.status, 'conflicts')
  assert.deepEqual(result.report.conflicts, [
    { path: 'legacy.txt', reason: '项目已删除该文件，模板修改了它' },
  ])
  assert.equal(existsSync(join(project.dir, 'legacy.txt')), false)
})

test('a failing verification keeps the baseline record and the branch for investigation', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit(
    { 'src/app.ts': "import { core } from '@saas/core'\n\nexport const app = core('v2')\n" },
    'change',
  )
  const { runner } = stubRunner({ fail: ['pnpm typecheck'] })
  const result = await runSync({ project: project.dir, template: template.dir, runner, log: quiet })
  assert.equal(result.status, 'failed')
  assert.equal((await readBaseRecord(project.dir)).commit, template.first)
  assert.equal(git(project.dir, 'branch', '--show-current'), result.branch)
  assert.equal(git(project.dir, 'rev-list', '--count', 'main..HEAD'), '1')
  const report = await readFile(result.reportPath, 'utf8')
  assert.match(report, /类型检查：失败（`pnpm typecheck`）/)
  assert.match(report, /单元测试：跳过/)
  assert.match(report, /基准记录：未更新/)
})

test('--skip-verify merges and ports but never updates the baseline and exits non-zero', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit(
    {
      'src/app.ts': "import { core } from '@saas/core'\n\nexport const app = core('v2')\n",
      'packages/db/migrations/0001_feature.sql': 'CREATE TABLE "feature" (id int);\n',
      'packages/db/migrations/meta/_journal.json': journal(['0000_init', '0001_feature']),
    },
    'change',
  )
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./template-sync.mjs', import.meta.url)),
      'sync',
      '--project',
      project.dir,
      '--template',
      template.dir,
      '--skip-verify',
    ],
    {
      encoding: 'utf8',
    },
  )
  assert.equal(cli.status, 1, cli.stderr)
  assert.match(cli.stderr, /验证已跳过，基准记录未更新/)
  assert.equal((await readBaseRecord(project.dir)).commit, template.first)
  assert.match(await readFile(join(project.dir, 'src/app.ts'), 'utf8'), /core\('v2'\)/)
  assert.equal(existsSync(join(project.dir, 'packages/db/migrations/0001_tpl_feature.sql')), true)
  assert.equal(git(project.dir, 'rev-list', '--count', 'main..HEAD'), '1')
  const reportPath = cli.stderr.match(/同步报告：(.+)/)[1].trim()
  const report = await readFile(reportPath, 'utf8')
  assert.match(report, /验证已跳过，基准未更新/)
  assert.match(report, /基准记录：未更新/)
  assert.match(report, /类型检查：跳过/)
})

test('a modified published template migration stops the sync before any branch', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit(
    { 'packages/db/migrations/0000_init.sql': 'CREATE TABLE "a" (id bigint);\n' },
    'edit published migration',
  )
  await assert.rejects(
    runSync({
      project: project.dir,
      template: template.dir,
      runner: stubRunner().runner,
      log: quiet,
    }),
    (error) => error instanceof PreflightError && /0000_init/.test(error.message),
  )
  assert.deepEqual(await branches(project.dir), ['main'])
})

test('--skip-migration records skipped tags as handled and later syncs do not offer them again', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit(
    {
      'packages/db/migrations/0001_engine.sql': 'CREATE SCHEMA job_engine;\n',
      'packages/db/migrations/0002_grants.sql': 'GRANT USAGE ON SCHEMA job_engine TO app;\n',
      'packages/db/migrations/0003_audit.sql': 'ALTER TABLE "a" ADD COLUMN note text;\n',
      'packages/db/migrations/meta/_journal.json': journal([
        '0000_init',
        '0001_engine',
        '0002_grants',
        '0003_audit',
      ]),
    },
    'three migrations',
  )
  await assert.rejects(
    runSync({
      project: project.dir,
      template: template.dir,
      skipMigrations: ['0009_unknown'],
      runner: stubRunner().runner,
      log: quiet,
    }),
    (error) => error instanceof PreflightError && /0009_unknown/.test(error.message),
  )
  assert.deepEqual(await branches(project.dir), ['main'])

  const result = await runSync({
    project: project.dir,
    template: template.dir,
    skipMigrations: ['0001_engine', '0002_grants'],
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(result.status, 'synced')
  assert.deepEqual(
    result.report.ported.map((item) => [item.source, item.tag]),
    [['0003_audit', '0001_tpl_audit']],
  )
  assert.deepEqual(result.report.skippedMigrations, ['0001_engine', '0002_grants'])
  assert.deepEqual((await readBaseRecord(project.dir)).migrations, [
    '0000_init',
    '0003_audit',
    '0001_engine',
    '0002_grants',
  ])
  assert.match(
    await readFile(result.reportPath, 'utf8'),
    /## 已跳过的迁移\n\n- `0001_engine`\n- `0002_grants`\n\n.*自行确认/,
  )

  git(project.dir, 'switch', '--quiet', 'main')
  git(project.dir, 'merge', '--quiet', '--ff-only', result.branch)
  await template.commit({ 'src/app.ts': "export const app = 'v3'\n" }, 'unrelated')
  const again = await runSync({
    project: project.dir,
    template: template.dir,
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(again.status, 'synced')
  assert.deepEqual(again.report.ported, [])
  assert.deepEqual(again.report.skippedMigrations, [])
})

test('lockfile diff compares resolved versions by package name', () => {
  const before =
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\npackages:\n\n  '@scope/a@1.0.0':\n    resolution: {}\n\n  b@2.0.0:\n    resolution: {}\n\n  gone@1.0.0:\n    resolution: {}\n\nsnapshots:\n\n  b@2.0.0(react@18.0.0): {}\n"
  const after =
    "lockfileVersion: '9.0'\n\npackages:\n\n  '@scope/a@1.1.0':\n    resolution: {}\n\n  b@2.0.0:\n    resolution: {}\n\n  new@0.1.0:\n    resolution: {}\n"
  assert.deepEqual(diffLockPackages(before, after), [
    { name: '@scope/a', before: ['1.0.0'], after: ['1.1.0'] },
    { name: 'gone', before: ['1.0.0'], after: [] },
    { name: 'new', before: [], after: ['0.1.0'] },
  ])
})

function upgrade(
  version,
  {
    previous = 'v0.1.3',
    requiresDeployed,
    summary = `升级 ${version}`,
    actions = '无',
    migrations = [],
  } = {},
) {
  const skeleton = readFileSync(new URL('../docs/upgrades/_template.md', import.meta.url), 'utf8')
  return skeleton
    .replace('version: 0.2.0', `version: ${version}`)
    .replace('previous: v0.1.3', `previous: ${previous}`)
    .replace('date: YYYY-MM-DD', 'date: 2026-10-26')
    .replace(
      'breaking: false',
      `breaking: true${requiresDeployed ? `\nrequiresDeployed: ${requiresDeployed}` : ''}`,
    )
    .replace('## 概要\n\n无', `## 概要\n\n${summary}`)
    .replace('## 必须执行的动作\n\n无', `## 必须执行的动作\n\n${actions}`)
    .replace(
      '## 数据库变更\n\n无',
      `## 数据库变更\n\n${migrations.length ? migrations.map((tag) => `### ${tag}\n\n- 类别：扩展\n- 兼容上一版本代码：是\n- 锁表与耗时：无\n- 回滚：回退代码`).join('\n\n') : '无'}`,
    )
}

test('default target is the highest annotated release and unpublished HEAD needs explicit --to', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template, template.first, { repository: null })
  const target = await template.commit(
    { 'docs/upgrades/0.2.0.md': upgrade('0.2.0'), 'src/release.ts': 'released\n' },
    'release',
    'template-v0.2.0',
  )
  await template.commit({ 'src/future.ts': 'not released\n' }, 'future')
  git(template.dir, 'tag', 'template-v9.0.0')
  const result = await runSync({
    project: project.dir,
    template: template.dir,
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(result.report.target.commit, target)
  assert.equal(result.report.upgrades.documents[0].link, 'docs/upgrades/0.2.0.md')
  assert.equal((await readBaseRecord(project.dir)).version, '0.2.0')
  assert.equal(existsSync(join(project.dir, 'src/future.ts')), false)
  assert.deepEqual(
    result.report.upgrades.documents.map((doc) => doc.version),
    ['0.2.0'],
  )
})

test('without release tags the default falls back to unpublished HEAD and reports the fallback', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  const head = await template.commit({ 'src/change.ts': 'change\n' }, 'change')
  const result = await runSync({
    project: project.dir,
    template: template.dir,
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal((await readBaseRecord(project.dir)).commit, head)
  assert.equal((await readBaseRecord(project.dir)).version, null)
  assert.match(await readFile(result.reportPath, 'utf8'), /默认目标回退到 HEAD（目标未发布）/)
})

test('deployment boundaries stop at the earliest release, require confirmation at that baseline, and accept repeated confirmations', async (t) => {
  const template = await fakeTemplate(t)
  git(template.dir, 'tag', '-a', 'template-v0.1.0', '-m', 'initial')
  const project = await fakeProject(t, template, template.first, { version: '0.1.0' })
  const r2 = await template.commit(
    {
      'docs/upgrades/0.2.0.md': upgrade('0.2.0', {
        summary: '边界版本说明',
        actions: '1. 部署边界版本。',
      }),
    },
    'expand',
    'template-v0.2.0',
  )
  const r3 = await template.commit(
    { 'docs/upgrades/0.3.0.md': upgrade('0.3.0', { requiresDeployed: '0.2.0' }) },
    'contract one',
    'template-v0.3.0',
  )
  const r4 = await template.commit(
    {
      'docs/upgrades/0.4.0.md': upgrade('0.4.0', { requiresDeployed: '0.3.0' }),
      'docs/upgrades/0.2.0.md': upgrade('0.2.0', {
        summary: '未来勘误说明',
        actions: '1. 未来版本动作。',
        migrations: ['0099_future'],
      }),
    },
    'contract two',
    'template-v0.4.0',
  )
  const first = await runSync({
    project: project.dir,
    template: template.dir,
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(first.report.target.commit, r2)
  assert.equal(first.report.upgrades.documents[0].summary, '边界版本说明')
  assert.deepEqual(
    first.report.upgrades.documents[0].actions.map((action) => action.text),
    ['部署边界版本。'],
  )
  assert.deepEqual(first.report.migrationComparison.documented, [])
  assert.ok(first.report.upgrades.documents[0].link.includes(`/blob/${r2}/`))
  assert.deepEqual(
    first.report.upgrades.documents.map((doc) => doc.version),
    ['0.2.0'],
  )
  assert.match(await readFile(first.reportPath, 'utf8'), /先部署 0.2.0.*--confirm-deployed 0.2.0/)
  const branch = git(project.dir, 'branch', '--show-current')
  const stopped = await runSync({
    project: project.dir,
    template: template.dir,
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(stopped.status, 'up-to-date')
  assert.equal(stopped.report.target.commit, r2)
  assert.equal(git(project.dir, 'branch', '--show-current'), branch)
  assert.equal(git(project.dir, 'status', '--porcelain'), '')
  const second = await runSync({
    project: project.dir,
    template: template.dir,
    confirmDeployed: ['0.2.0'],
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.equal(second.report.target.commit, r3)
  // CLI 接受重复声明；skip-verify 保留旧基准，只验证越过全部已声明边界的目标选择。
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./template-sync.mjs', import.meta.url)),
      'sync',
      '--project',
      project.dir,
      '--template',
      template.dir,
      '--confirm-deployed',
      '0.2.0',
      '--confirm-deployed',
      '0.3.0',
      '--skip-verify',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(cli.status, 1, cli.stderr)
  assert.equal(git(project.dir, 'branch', '--show-current'), `template-sync/${r4.slice(0, 12)}`)
  assert.equal((await readBaseRecord(project.dir)).commit, r3)
})

test('notes use the target-tree corrections, filter AND and list conditions, and warn for a baseline between releases', async (t) => {
  const template = await fakeTemplate(t)
  git(template.dir, 'tag', '-a', 'template-v0.1.0', '-m', 'initial')
  const base = await template.commit({ 'src/partial.ts': 'partial\n' }, 'partial')
  const project = await fakeProject(t, template, base)
  await template.commit(
    {
      'docs/upgrades/0.2.0.md': upgrade('0.2.0', {
        previous: '0.1.0',
        summary: '原说明',
        actions:
          '1. 所有人执行。\n2. 启用 AI。（适用：target=cloudflare; ai=text）\n3. selfhost 操作。（适用：target=selfhost; ai=text）\n4. 音频操作。（适用：ai=audio）',
      }),
    },
    'release',
    'template-v0.2.0',
  )
  await template.commit(
    {
      'docs/upgrades/0.2.0.md': upgrade('0.2.0', {
        previous: '0.1.0',
        summary: '勘误后的说明',
        actions:
          '1. 所有人执行。\n2. 启用 AI。（适用：target=cloudflare; ai=text）\n3. selfhost 操作。（适用：target=selfhost; ai=text）\n4. 音频操作。（适用：ai=audio）',
      }),
      'docs/upgrades/0.3.0.md': upgrade('0.3.0'),
    },
    'correction',
    'template-v0.3.0',
  )
  const result = await runSync({
    project: project.dir,
    template: template.dir,
    runner: stubRunner().runner,
    log: quiet,
  })
  const report = await readFile(result.reportPath, 'utf8')
  assert.deepEqual(
    result.report.upgrades.documents.map((doc) => doc.version),
    ['0.2.0', '0.3.0'],
  )
  assert.match(report, /勘误后的说明/)
  assert.match(report, /部分动作可能已随基准完成/)
  assert.doesNotMatch(report, /无法将 previous/)
  assert.deepEqual(
    result.report.upgrades.documents[0].actions.map((action) => action.text),
    ['所有人执行。', '启用 AI。'],
  )
  assert.match(report, /\[template-v0.2.0\]\(https:\/\/example.com\/acme\/template\/blob\//)
})

test('first release checks its ordinary previous tag and warns if that tag cannot be resolved', async (t) => {
  const template = await fakeTemplate(t)
  git(template.dir, 'tag', 'v0.1.3')
  const between = await template.commit({ 'src/partial.ts': 'partial\n' }, 'partial')
  const target = await template.commit(
    { 'docs/upgrades/0.2.0.md': upgrade('0.2.0', { previous: 'v0.1.3' }) },
    'first release',
    'template-v0.2.0',
  )
  for (const base of [template.first, between]) {
    const project = await fakeProject(t, template, base)
    const result = await runSync({
      project: project.dir,
      template: template.dir,
      runner: stubRunner().runner,
      log: quiet,
    })
    const report = await readFile(result.reportPath, 'utf8')
    if (base === between) assert.match(report, /部分动作可能已随基准完成/)
    else assert.doesNotMatch(report, /部分动作可能已随基准完成/)
    assert.doesNotMatch(report, /无法将 previous/)
  }
  git(template.dir, 'tag', '-d', 'v0.1.3')
  const project = await fakeProject(t, template)
  const result = await runSync({
    project: project.dir,
    template: template.dir,
    to: target,
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.match(
    await readFile(result.reportPath, 'utf8'),
    /部分动作可能已随基准完成.*无法将 previous v0\.1\.3 解析为提交：refs\/tags\/v0\.1\.3/,
  )
})

test('migration reconciliation includes skipped original tags and warns on mismatches and missing notes', async (t) => {
  const template = await fakeTemplate(t)
  const project = await fakeProject(t, template)
  await template.commit(
    {
      'docs/upgrades/0.2.0.md': upgrade('0.2.0', { migrations: ['0001_skip', '0099_documented'] }),
      'packages/db/migrations/0001_skip.sql': 'CREATE TABLE skipped (id int);\n',
      'packages/db/migrations/0002_port.sql': 'CREATE TABLE ported (id int);\n',
      'packages/db/migrations/meta/_journal.json': journal(['0000_init', '0001_skip', '0002_port']),
    },
    'release',
    'template-v0.2.0',
  )
  await template.commit({ 'src/no-notes.ts': 'no notes\n' }, 'missing notes', 'template-v0.3.0')
  const result = await runSync({
    project: project.dir,
    template: template.dir,
    skipMigrations: ['0001_skip'],
    runner: stubRunner().runner,
    log: quiet,
  })
  assert.deepEqual(result.report.migrationComparison.actual, ['0002_port', '0001_skip'])
  assert.deepEqual(result.report.migrationComparison.documented, ['0001_skip', '0099_documented'])
  assert.match(result.report.migrationComparison.warnings.join('\n'), /0002_port/)
  assert.match(result.report.migrationComparison.warnings.join('\n'), /0099_documented/)
  assert.doesNotMatch(result.report.migrationComparison.warnings.join('\n'), /0001_skip/)
  assert.match(
    await readFile(result.reportPath, 'utf8'),
    /警告：缺少升级说明：docs\/upgrades\/0.3.0.md/,
  )
})
