import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  classifyStatements,
  listReleases,
  parseUpgradeDoc,
  releasesBetween,
} from './template-release.mjs'

const script = fileURLToPath(new URL('./template-release.mjs', import.meta.url))
const headings = [
  '概要',
  '必须执行的动作',
  '配置变更',
  '数据库变更',
  '部署顺序',
  '验证',
  '回滚',
  '已知问题',
]
const migrationDir = 'packages/db/migrations'
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}

function put(cwd, file, text) {
  const target = path.join(cwd, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function commit(cwd, message = 'fix: fixture update') {
  git(cwd, 'add', '.')
  git(cwd, 'commit', '--allow-empty', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function tag(cwd, version) {
  git(cwd, 'tag', '-a', version, '-m', version)
}

function repo(t, { version = '0.2.0', migrations = {} } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'template-release-fixture-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '-b', 'main')
  put(cwd, 'package.json', '{"name":"fixture","dependencies":{"fixture-lib":"^1.0.0"}}\n')
  put(cwd, 'template.config.ts', 'export const templateConfig = { billing: false }\n')
  put(cwd, 'apps/web/wrangler.jsonc', '{"name":"fixture-web","vars":{},"services":[]}\n')
  put(cwd, 'apps/jobs/wrangler.jsonc', '{"name":"fixture-jobs","vars":{},"services":[]}\n')
  put(cwd, 'packages/config/src/env.ts', 'export const envSchema = { EXISTING_KEY: "optional" }\n')
  put(cwd, 'apps/web/.dev.vars.example', 'EXISTING_SECRET=\n')
  put(
    cwd,
    'scripts/create-project.mjs',
    'function setupChecklist() { return [`- [ ] Configure EXISTING_ITEM`] }\n',
  )
  put(
    cwd,
    'docs/upgrades/_template.md',
    upgrade({ version: '{{version}}', previous: '{{previous}}' }),
  )
  put(cwd, 'docs/upgrades/README.md', '# 升级说明\n')
  setMigrations(cwd, migrations)
  const base = commit(cwd, 'fix: initial fixture')
  if (version) tag(cwd, `template-v${version}`)
  return { cwd, base }
}

function setMigrations(cwd, migrations) {
  const entries = Object.entries(migrations).map(([name, sql], idx) => {
    put(cwd, `${migrationDir}/${name}.sql`, sql)
    return { idx, version: '7', when: 1700000000000 + idx, tag: name, breakpoints: true }
  })
  put(
    cwd,
    `${migrationDir}/meta/_journal.json`,
    `${JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2)}\n`,
  )
}

function migration(name = '0001_expand', category = '扩展', compatible = '是') {
  return `### ${name}\n\n- 类别：${category}\n- 兼容上一版本代码：${compatible}\n- 锁表与耗时：短暂元数据锁，秒级\n- 回滚：回退代码，保留新增结构\n\nfixture migration 摘要。\n`
}

function upgrade({
  version = '0.2.1',
  previous = '0.2.0',
  breaking = false,
  requiresDeployed,
  sections = {},
} = {}) {
  return `---\nversion: ${version}\nprevious: ${previous}\ndate: 2026-10-26\nbreaking: ${breaking}\n${requiresDeployed ? `requiresDeployed: ${requiresDeployed}\n` : ''}---\n\n# 升级 ${version}\n\n${headings.map((heading) => `## ${heading}\n\n${sections[heading] ?? (heading === '概要' ? '修复 fixture 行为。' : '无')}\n`).join('\n')}`
}

function releaseDoc(cwd, options = {}, text = upgrade(options)) {
  const version = options.version ?? '0.2.1'
  const previous = (options.previous ?? '0.2.0').replace(/^v/, '').split('.')
  const next = version.split('.')
  const level = next[0] !== previous[0] ? 'MAJOR' : next[1] !== previous[1] ? 'MINOR' : 'PATCH'
  put(cwd, `docs/upgrades/${version}.md`, text)
  put(
    cwd,
    'docs/upgrades/README.md',
    `# 升级说明\n\n| 版本 | 日期 | 级别 | 不兼容 |\n| --- | --- | --- | --- |\n| [${version}](./${version}.md) | 2026-10-26 | ${level} | ${options.breaking ? '是' : '否'} |\n`,
  )
}

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' })
}

function succeeds(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return `${result.stdout}\n${result.stderr}`
}

function fails(result) {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /\S/)
}

test('SQL classification covers expansion, data changes, and destructive schema changes', () => {
  const statements = classifyStatements(
    `CREATE TABLE fixture (id integer);\nALTER TABLE fixture ADD COLUMN note text;\nALTER TABLE fixture ADD COLUMN ready boolean NOT NULL DEFAULT false;\nUPDATE fixture SET note = 'ready';\nINSERT INTO fixture (id) VALUES (1);\nDELETE FROM fixture WHERE id = 1;\nALTER TABLE fixture DROP COLUMN note;\nDROP TABLE fixture;\nALTER TABLE fixture DROP CONSTRAINT fixture_pkey;\nALTER TABLE fixture RENAME COLUMN id TO key;\nALTER TABLE fixture ALTER COLUMN id TYPE bigint;\nALTER TABLE fixture ALTER COLUMN id SET NOT NULL;\nALTER TABLE fixture ADD COLUMN required text NOT NULL;`,
  )
  assert.deepEqual(
    statements.map((statement) => statement.category),
    [
      '扩展',
      '扩展',
      '扩展',
      '数据迁移',
      '数据迁移',
      '数据迁移',
      '收缩',
      '收缩',
      '收缩',
      '收缩',
      '收缩',
      '收缩',
      '收缩',
    ],
  )
})

test('contract annotation applies to its own statement, not the following statement', () => {
  const statements = classifyStatements(
    '-- template-contract: 已部署 0.2.0，旧字段已停用\nALTER TABLE fixture DROP COLUMN old;\n--> statement-breakpoint\nALTER TABLE fixture DROP COLUMN other;',
  )
  assert.match(statements[0].contractReason, /0\.2\.0/)
  assert.equal(statements[1].contractReason, null)
})

test('parseUpgradeDoc returns conditional and unconditional ordered actions', () => {
  const parsed = parseUpgradeDoc(
    upgrade({
      sections: {
        必须执行的动作: '1. 配置绑定（适用：target=selfhost; billing-enabled=true）\n2. 执行验证',
      },
    }),
  )
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.actions.length, 2)
  assert.deepEqual(parsed.actions[0].conditions, { target: 'selfhost', 'billing-enabled': 'true' })
  assert.deepEqual(parsed.actions[1].conditions, {})
  assert.match(parsed.actions[0].text, /配置绑定/)
})

test('release helpers sort SemVer and select only releases inside the commit interval', (t) => {
  const { cwd, base } = repo(t, { version: '0.2.9' })
  const between = commit(cwd)
  tag(cwd, 'template-v0.2.10')
  const middle = commit(cwd)
  commit(cwd)
  tag(cwd, 'template-v0.3.0')
  const target = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'checkout', '-b', 'side', base)
  commit(cwd, 'fix: independent side branch')
  tag(cwd, 'template-v0.9.0')
  git(cwd, 'checkout', 'main')
  tag(cwd, 'v8.0.0')
  tag(cwd, 'template-vinvalid')
  git(cwd, 'tag', 'template-v8.0.0')
  assert.deepEqual(
    listReleases(cwd).map((release) => release.version),
    ['0.2.9', '0.2.10', '0.3.0', '0.9.0'],
  )
  assert.deepEqual(
    releasesBetween(middle, target, cwd).map((release) => release.version),
    ['0.3.0'],
  )
  assert.deepEqual(
    releasesBetween(base, target, cwd).map((release) => release.version),
    ['0.2.10', '0.3.0'],
  )
  assert.equal(listReleases(cwd).find((release) => release.version === '0.2.10').commit, between)
})

test('draft includes all evidence categories and flags new secrets as breaking', (t) => {
  const { cwd } = repo(t)
  setMigrations(cwd, {
    '0001_expand': 'CREATE TABLE fixture (id integer);',
    '0002_contract':
      '-- template-contract: 已部署 0.2.0，旧字段已停用\nALTER TABLE fixture DROP COLUMN old;',
    '0003_data': 'UPDATE fixture SET id = 1 WHERE id = 0;',
  })
  put(
    cwd,
    'template.config.ts',
    'export const templateConfig = { billing: true, newFeature: true }\n',
  )
  put(
    cwd,
    'apps/web/wrangler.jsonc',
    '{"name":"fixture-web","vars":{},"services":[{"binding":"NEW_SERVICE","service":"fixture-jobs"}]}\n',
  )
  put(
    cwd,
    'packages/config/src/env.ts',
    'export const envSchema = { EXISTING_KEY: "optional", NEW_REQUIRED_ENV: "required" }\n',
  )
  put(cwd, 'apps/web/.dev.vars.example', 'EXISTING_SECRET=\nNEW_REQUIRED_SECRET=\n')
  put(
    cwd,
    'scripts/create-project.mjs',
    'function setupChecklist() { return [`- [ ] Configure NEW_SETUP_ITEM`] }\n',
  )
  put(cwd, 'package.json', '{"name":"fixture","dependencies":{"fixture-lib":"^2.0.0"}}\n')
  commit(cwd, 'feat: add fixture capability (#42)')
  const output = succeeds(cli(cwd, 'draft', '--version', '0.3.0'))
  for (const expected of [
    '0001_expand',
    '0002_contract',
    '0003_data',
    '扩展',
    '收缩',
    '数据迁移',
    'template.config.ts',
    'NEW_SERVICE',
    'NEW_REQUIRED_ENV',
    'NEW_REQUIRED_SECRET',
    'NEW_SETUP_ITEM',
    'fixture-lib',
    '42',
  ]) {
    assert.ok(output.includes(expected), `missing draft evidence: ${expected}\n${output}`)
  }
  assert.match(output, /MINOR|minor/)
  assert.match(output, /breaking:\s*true|不兼容/)
})

test('draft uses v0.1.3 when no template release exists', (t) => {
  const { cwd } = repo(t, { version: null })
  tag(cwd, 'v0.1.3')
  commit(cwd, 'fix: AFTER_BASE_SENTINEL')
  const output = succeeds(cli(cwd, 'draft', '--version', '0.2.0'))
  assert.match(output, /v0\.1\.3/)
  assert.match(output, /AFTER_BASE_SENTINEL/)
  assert.doesNotMatch(output, /initial fixture/)
})

test('draft selects highest SemVer ancestor and ignores side branch and production tags', (t) => {
  const { cwd, base } = repo(t, { version: '0.2.9' })
  commit(cwd)
  tag(cwd, 'template-v0.2.10')
  commit(cwd, 'fix: ONLY_NEW_CHANGE')
  git(cwd, 'checkout', '-b', 'side', base)
  commit(cwd, 'feat: SIDE_ONLY')
  tag(cwd, 'template-v9.0.0')
  git(cwd, 'checkout', 'main')
  tag(cwd, 'v99.0.0')
  const output = succeeds(cli(cwd, 'draft', '--version', '0.2.11'))
  assert.match(output, /0\.2\.10.*HEAD/)
  assert.match(output, /ONLY_NEW_CHANGE/)
  assert.doesNotMatch(output, /SIDE_ONLY/)
})

test('draft --write uses the repository skeleton and refuses to overwrite it', (t) => {
  const { cwd } = repo(t)
  put(cwd, 'docs/upgrades/_template.md', `${upgrade()}\n<!-- CUSTOM_SKELETON_SENTINEL -->\n`)
  commit(cwd)
  succeeds(cli(cwd, 'draft', '--version', '0.2.1', '--write'))
  const generated = readFileSync(path.join(cwd, 'docs/upgrades/0.2.1.md'), 'utf8')
  assert.match(generated, /CUSTOM_SKELETON_SENTINEL/)
  fails(cli(cwd, 'draft', '--version', '0.2.1', '--write'))
  assert.equal(readFileSync(path.join(cwd, 'docs/upgrades/0.2.1.md'), 'utf8'), generated)
})

test('check accepts a complete fix release before and after its tag exists', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd)
  commit(cwd)
  succeeds(cli(cwd, 'check', '--version', '0.2.1'))
  tag(cwd, 'template-v0.2.1')
  setMigrations(cwd, { '0001_future': 'CREATE TABLE future (id integer);' })
  commit(cwd, 'feat: future release')
  succeeds(cli(cwd, 'check', '--version', '0.2.1'))
})

const malformedDocs = [
  ['missing frontmatter', (text) => text.replace(/^---[\s\S]*?---\n/, '')],
  ['missing required version', (text) => text.replace('version: 0.2.1\n', '')],
  ['version disagrees with command', (text) => text.replace('version: 0.2.1', 'version: 0.2.2')],
  ['version has v prefix', (text) => text.replace('version: 0.2.1', 'version: v0.2.1')],
  ['invalid previous', (text) => text.replace('previous: 0.2.0', 'previous: 0.1.9')],
  [
    'previous template version has v prefix',
    (text) => text.replace('previous: 0.2.0', 'previous: v0.2.0'),
  ],
  ['missing date', (text) => text.replace('date: 2026-10-26\n', '')],
  ['impossible calendar date', (text) => text.replace('date: 2026-10-26', 'date: 2026-02-30')],
  ['nonboolean breaking', (text) => text.replace('breaking: false', 'breaking: maybe')],
  ['missing breaking', (text) => text.replace('breaking: false\n', '')],
  ['invalid YAML field', (text) => text.replace('breaking: false', 'breaking false')],
  ['missing fixed section', (text) => text.replace('## 已知问题\n\n无\n', '')],
  ['empty section', (text) => text.replace('## 验证\n\n无', '## 验证\n')],
  ['duplicate section', (text) => `${text}\n## 验证\n\n无\n`],
  [
    'unordered action',
    (text) => text.replace('## 必须执行的动作\n\n无', '## 必须执行的动作\n\n- 配置绑定'),
  ],
  [
    'malformed action condition',
    (text) =>
      text.replace('## 必须执行的动作\n\n无', '## 必须执行的动作\n\n1. 配置绑定（适用：target）'),
  ],
]
for (const [name, mutate] of malformedDocs) {
  test(`check rejects ${name}`, (t) => {
    const { cwd } = repo(t)
    releaseDoc(cwd, {}, mutate(upgrade()))
    commit(cwd)
    fails(cli(cwd, 'check', '--version', '0.2.1'))
  })
}

test('check rejects invalid command versions', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd)
  commit(cwd)
  for (const version of ['v0.2.1', '0.2', '0.02.1']) fails(cli(cwd, 'check', '--version', version))
})

test('check rejects missing index entries', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd)
  put(cwd, 'docs/upgrades/README.md', '# 升级说明\n')
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('check accepts first release with v0.1.3 previous', (t) => {
  const { cwd } = repo(t, { version: null })
  tag(cwd, 'v0.1.3')
  releaseDoc(cwd, { version: '0.2.0', previous: 'v0.1.3', breaking: true })
  commit(cwd)
  succeeds(cli(cwd, 'check', '--version', '0.2.0'))
})

const invalidMigrationDocs = [
  ['missing migration', '无'],
  ['extra migration', `${migration()}\n${migration('0002_extra')}`],
  ['duplicate migration', `${migration()}\n${migration()}`],
  ['invalid category', migration('0001_expand', '未知')],
  ['incompatible with previous code', migration('0001_expand', '扩展', '否')],
  ['missing compatibility', migration().replace('- 兼容上一版本代码：是\n', '')],
  ['missing lock risk', migration().replace('- 锁表与耗时：短暂元数据锁，秒级\n', '')],
  ['missing rollback', migration().replace('- 回滚：回退代码，保留新增结构\n', '')],
]
for (const [name, database] of invalidMigrationDocs) {
  test(`check rejects ${name}`, (t) => {
    const { cwd } = repo(t)
    setMigrations(cwd, { '0001_expand': 'CREATE TABLE fixture (id integer);' })
    releaseDoc(cwd, { sections: { 数据库变更: database } })
    commit(cwd)
    fails(cli(cwd, 'check', '--version', '0.2.1'))
  })
}

test('check accepts a documented expansion migration', (t) => {
  const { cwd } = repo(t)
  setMigrations(cwd, { '0001_expand': 'CREATE TABLE fixture (id integer);' })
  releaseDoc(cwd, { sections: { 数据库变更: migration() } })
  commit(cwd)
  succeeds(cli(cwd, 'check', '--version', '0.2.1'))
})

for (const [name, overrides] of [
  ['missing requiresDeployed', {}],
  ['invalid requiresDeployed', { requiresDeployed: 'banana' }],
  ['future requiresDeployed', { requiresDeployed: '0.4.0' }],
  ['breaking must be true', { requiresDeployed: '0.2.0', breaking: false }],
]) {
  test(`check rejects contract migration: ${name}`, (t) => {
    const { cwd } = repo(t)
    setMigrations(cwd, {
      '0001_contract':
        '-- template-contract: 已部署 0.2.0，旧字段已停用\nALTER TABLE fixture DROP COLUMN old;',
    })
    const options = {
      version: '0.3.0',
      breaking: true,
      sections: { 数据库变更: migration('0001_contract', '收缩') },
      ...overrides,
    }
    releaseDoc(cwd, options)
    commit(cwd)
    fails(cli(cwd, 'check', '--version', '0.3.0'))
  })
}

test('check accepts a compatible contract release after its required version', (t) => {
  const { cwd } = repo(t)
  setMigrations(cwd, {
    '0001_contract':
      '-- template-contract: 已部署 0.2.0，旧字段已停用\nALTER TABLE fixture DROP COLUMN old;',
  })
  releaseDoc(cwd, {
    version: '0.3.0',
    breaking: true,
    requiresDeployed: '0.2.0',
    sections: { 数据库变更: migration('0001_contract', '收缩') },
  })
  commit(cwd)
  succeeds(cli(cwd, 'check', '--version', '0.3.0'))
})

for (const [previous, version, breaking, subject] of [
  ['0.2.0', '0.2.1', true, 'fix: manual upgrade'],
  ['1.2.0', '1.3.0', true, 'fix: manual upgrade'],
  ['1.2.0', '1.2.1', false, 'feat: new capability'],
]) {
  test(`check rejects insufficient version level ${previous} to ${version}`, (t) => {
    const { cwd } = repo(t, { version: previous })
    releaseDoc(cwd, { version, previous, breaking })
    commit(cwd, subject)
    fails(cli(cwd, 'check', '--version', version))
  })
}

test('check detects a newly required secret even when breaking is false', (t) => {
  const { cwd } = repo(t)
  put(cwd, 'apps/web/.dev.vars.example', 'EXISTING_SECRET=\nNEW_REQUIRED_SECRET=\n')
  releaseDoc(cwd)
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('lint-migrations rejects unannotated contraction and accepts an annotation', (t) => {
  const { cwd } = repo(t)
  git(cwd, 'checkout', '-b', 'feature')
  setMigrations(cwd, { '0001_contract': 'ALTER TABLE fixture DROP COLUMN old;' })
  commit(cwd)
  fails(cli(cwd, 'lint-migrations', '--base', 'main'))
  put(
    cwd,
    `${migrationDir}/0001_contract.sql`,
    '-- template-contract: 已部署 0.2.0，旧字段已停用\nALTER TABLE fixture DROP COLUMN old;',
  )
  commit(cwd)
  succeeds(cli(cwd, 'lint-migrations', '--base', 'main'))
})

test('lint-migrations does not retroactively lint unchanged historical SQL', (t) => {
  const { cwd } = repo(t, { migrations: { '0000_legacy': 'ALTER TABLE fixture DROP COLUMN old;' } })
  git(cwd, 'checkout', '-b', 'feature')
  commit(cwd)
  succeeds(cli(cwd, 'lint-migrations', '--base', 'main'))
})

test('lint-migrations rejects changes to already published migrations', (t) => {
  const { cwd } = repo(t, { migrations: { '0000_legacy': 'CREATE TABLE fixture (id integer);' } })
  git(cwd, 'checkout', '-b', 'feature')
  put(cwd, `${migrationDir}/0000_legacy.sql`, 'CREATE TABLE fixture (id bigint);')
  commit(cwd)
  fails(cli(cwd, 'lint-migrations', '--base', 'main'))
})

test('lint-migrations skips modifications to existing unpublished migrations', (t) => {
  const { cwd } = repo(t, {
    version: null,
    migrations: { '0000_unpublished': 'CREATE TABLE fixture (id integer);' },
  })
  git(cwd, 'checkout', '-b', 'feature')
  put(cwd, `${migrationDir}/0000_unpublished.sql`, 'ALTER TABLE fixture DROP COLUMN old;')
  commit(cwd)
  succeeds(cli(cwd, 'lint-migrations', '--base', 'main'))
})

test('each ADD COLUMN clause classifies its own NOT NULL default requirement', () => {
  const [statement] = classifyStatements(
    "ALTER TABLE fixture ADD COLUMN optional text DEFAULT 'ok', ADD COLUMN required text NOT NULL;",
  )
  assert.equal(statement.category, '收缩')
})

test('SQL comments and string values do not invent contraction statements', () => {
  const statements = classifyStatements(
    "-- DROP TABLE ignored;\nCREATE TABLE fixture (note text DEFAULT 'DROP COLUMN ignored;');\n/* ALTER TABLE fixture DROP COLUMN ignored; */\nINSERT INTO fixture (note) VALUES ('RENAME;');",
  )
  assert.deepEqual(
    statements.map((statement) => statement.category),
    ['扩展', '数据迁移'],
  )
})

for (const [name, unsafe] of [
  ['personal email', '联系 person@example.com'],
  ['secret value', 'STRIPE_SECRET_KEY=fixture-only-value'],
  ['production resource ID', '生产资源 0123456789abcdef0123456789abcdef'],
]) {
  test(`check rejects upgrade text containing ${name}`, (t) => {
    const { cwd } = repo(t)
    releaseDoc(cwd, { sections: { 已知问题: unsafe } })
    commit(cwd)
    fails(cli(cwd, 'check', '--version', '0.2.1'))
  })
}

test('valid prerelease and build tags use SemVer precedence while invalid tags are ignored', (t) => {
  const { cwd } = repo(t, { version: null })
  for (const version of ['1.0.0-rc.2', '1.0.0-rc.10', '1.0.0+build.7', '1.0.0-01', '01.0.0']) {
    tag(cwd, `template-v${version}`)
  }
  assert.deepEqual(
    listReleases(cwd).map((release) => release.version),
    ['1.0.0-rc.2', '1.0.0-rc.10', '1.0.0+build.7'],
  )
})

for (const [name, mutate] of [
  [
    'duplicate frontmatter field',
    (text) => text.replace('breaking: false', 'breaking: false\nbreaking: false'),
  ],
  [
    'sections in the wrong order',
    (text) =>
      text
        .replace('## 验证', '## TEMP')
        .replace('## 回滚', '## 验证')
        .replace('## TEMP', '## 回滚'),
  ],
  [
    'unknown condition key',
    (text) =>
      text.replace(
        '## 必须执行的动作\n\n无',
        '## 必须执行的动作\n\n1. 配置绑定（适用：unknown=true）',
      ),
  ],
  [
    'nonconsecutive actions',
    (text) => text.replace('## 必须执行的动作\n\n无', '## 必须执行的动作\n\n2. 执行验证'),
  ],
]) {
  test(`check rejects ${name}`, (t) => {
    const { cwd } = repo(t)
    releaseDoc(cwd, {}, mutate(upgrade()))
    commit(cwd)
    fails(cli(cwd, 'check', '--version', '0.2.1'))
  })
}

test('check rejects tagged frontmatter that disagrees with the tag version', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd, {}, upgrade().replace('version: 0.2.1', 'version: 0.2.2'))
  commit(cwd)
  tag(cwd, 'template-v0.2.1')
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('check rejects duplicate migration fields', (t) => {
  const { cwd } = repo(t)
  setMigrations(cwd, { '0001_expand': 'CREATE TABLE fixture (id integer);' })
  releaseDoc(cwd, {
    sections: { 数据库变更: migration().replace('- 类别：扩展', '- 类别：扩展\n- 类别：扩展') },
  })
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('check requires breaking true for valid manual upgrade actions', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd, { sections: { 必须执行的动作: '1. 调整自有代码（适用：target=selfhost）' } })
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('check rejects a requiresDeployed release from an unrelated branch', (t) => {
  const { cwd, base } = repo(t)
  git(cwd, 'checkout', '-b', 'side', base)
  commit(cwd)
  tag(cwd, 'template-v0.2.1')
  git(cwd, 'checkout', 'main')
  setMigrations(cwd, {
    '0001_contract':
      '-- template-contract: 已部署 0.2.1，旧字段已停用\nALTER TABLE fixture DROP COLUMN old;',
  })
  releaseDoc(cwd, {
    version: '0.3.0',
    breaking: true,
    requiresDeployed: '0.2.1',
    sections: { 数据库变更: migration('0001_contract', '收缩') },
  })
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.3.0'))
})

test('check rejects a contract migration without its statement annotation', (t) => {
  const { cwd } = repo(t)
  setMigrations(cwd, { '0001_contract': 'ALTER TABLE fixture DROP COLUMN old;' })
  releaseDoc(cwd, {
    version: '0.3.0',
    breaking: true,
    requiresDeployed: '0.2.0',
    sections: { 数据库变更: migration('0001_contract', '收缩') },
  })
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.3.0'))
})

for (const [previous, version, breaking, subject] of [
  ['0.2.0', '0.3.0', false, 'fix: small repair'],
  ['0.2.0', '0.3.1', true, 'fix: manual upgrade'],
  ['1.2.0', '2.0.0', false, 'fix: small repair'],
  ['1.2.0', '1.3.1', false, 'feat: new capability'],
  ['1.2.0', '2.1.0', true, 'fix: manual upgrade'],
]) {
  test(`check rejects an invalid ${breaking ? 'breaking' : 'compatible'} bump ${previous} to ${version}`, (t) => {
    const { cwd } = repo(t, { version: previous })
    releaseDoc(cwd, { version, previous, breaking })
    commit(cwd, subject)
    fails(cli(cwd, 'check', '--version', version))
  })
}

test('check requires a version index entry even when prose mentions the version', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd)
  put(cwd, 'docs/upgrades/README.md', '# 升级说明\n\n计划发布 0.2.1。\n')
  commit(cwd)
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('check validates edits and deletion of an already released upgrade document', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd)
  commit(cwd)
  tag(cwd, 'template-v0.2.1')
  releaseDoc(cwd, {}, upgrade().replace('version: 0.2.1', 'version: 0.2.2'))
  fails(cli(cwd, 'check', '--version', '0.2.1'))
  rmSync(path.join(cwd, 'docs/upgrades/0.2.1.md'))
  fails(cli(cwd, 'check', '--version', '0.2.1'))
})

test('check accepts a separate upgrade link column in the version index', (t) => {
  const { cwd } = repo(t)
  releaseDoc(cwd)
  put(cwd, 'docs/upgrades/README.md', '| 0.2.1 | 2026-10-26 | PATCH | 否 | [说明](0.2.1.md) |\n')
  commit(cwd)
  succeeds(cli(cwd, 'check', '--version', '0.2.1'))
})

test('new defaulted configuration and optional environment keys remain compatible', (t) => {
  const { cwd } = repo(t)
  put(
    cwd,
    'template.config.ts',
    'export const templateConfig = {\n  billing: false,\n  newFeature: false,\n}\n',
  )
  put(
    cwd,
    'packages/config/src/template.ts',
    'export interface TemplateConfig {\n  readonly newFeature: boolean\n}\n',
  )
  put(
    cwd,
    'packages/config/src/env.ts',
    'export const envSchema = {\n  EXISTING_KEY: "optional",\n  OPTIONAL_KEY: z.string()\n    .optional(),\n}\n',
  )
  releaseDoc(cwd)
  commit(cwd, 'feat: add optional capability')
  succeeds(cli(cwd, 'check', '--version', '0.2.1'))
})

test('migration headings contain only the migration tag', () => {
  const parsed = parseUpgradeDoc(
    upgrade({
      sections: {
        数据库变更: migration().replace('### 0001_expand', '### 0001_expand extra heading text'),
      },
    }),
  )
  assert.ok(parsed.errors.some((error) => error.includes('migration heading')))
})

test('draft reports Rate Limiting binding names without treating resource names as bindings', (t) => {
  const { cwd } = repo(t)
  put(
    cwd,
    'apps/web/wrangler.jsonc',
    '{"name":"renamed-resource","ratelimits":[{"name":"RL_NEW","namespace_id":"1000","simple":{"limit":10,"period":60}}]}\n',
  )
  commit(cwd)
  const output = succeeds(cli(cwd, 'draft', '--version', '0.3.0'))
  assert.match(output, /RL_NEW/)
  assert.doesNotMatch(output, /renamed-resource/)
})

for (const [previous, version, breaking, subject] of [
  ['1.2.0', '1.3.0', false, 'feat: new capability'],
  ['1.2.0', '2.0.0', true, 'fix: manual upgrade'],
]) {
  test(`check accepts a valid ${breaking ? 'breaking' : 'feature'} bump ${previous} to ${version}`, (t) => {
    const { cwd } = repo(t, { version: previous })
    releaseDoc(cwd, { version, previous, breaking })
    commit(cwd, subject)
    succeeds(cli(cwd, 'check', '--version', version))
  })
}
