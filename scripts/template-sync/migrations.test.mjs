import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultRunner } from '../template-sync.mjs'
import {
  drizzleGenerate,
  isEmptyDatabase,
  migrateIncrementally,
  migrationsPath,
  migrationsWithout,
  planMigrations,
  portMigrations,
} from './migrations.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'template-sync-migrations-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Write a migrations folder under `<root>/packages/db/migrations` from [tag, when, sql] rows. */
async function migrations(root, rows) {
  const dir = join(root, migrationsPath)
  await mkdir(join(dir, 'meta'), { recursive: true })
  for (const [tag, , sql] of rows) {
    await writeFile(join(dir, `${tag}.sql`), sql)
    await writeFile(
      join(dir, `meta/${tag.split('_')[0]}_snapshot.json`),
      `${JSON.stringify({ id: `snap-${tag}`, prevId: 'p', tables: {} }, null, 2)}\n`,
    )
  }
  const entries = rows.map(([tag, when], idx) => ({
    idx,
    version: '7',
    when,
    tag,
    breakpoints: true,
  }))
  await writeFile(
    join(dir, 'meta/_journal.json'),
    `${JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2)}\n`,
  )
  return dir
}

test('ported template migrations follow project migrations even when the numbers collide', async (t) => {
  const root = await scratch(t)
  const base = join(root, 'base')
  const target = join(root, 'target')
  const project = join(root, 'project')
  await migrations(base, [['0000_init', 1000, 'select 1;\n']])
  await migrations(target, [
    ['0000_init', 1000, 'select 1;\n'],
    ['0001_node_job_engine', 9_000_000, 'select 2;\n'],
    ['0002_events', 9_000_001, 'select 3;\n'],
  ])
  await migrations(project, [
    ['0000_init', 1000, 'select 1;\n'],
    ['0001_superb_excalibur', 2_000_000_000_000, 'select 4;\n'],
  ])
  const plan = await planMigrations({ baseCopy: base, targetCopy: target, recorded: ['0000_init'] })
  const ported = await portMigrations(project, plan.port, target)
  assert.deepEqual(
    ported.map((item) => [item.source, item.tag, item.when]),
    [
      ['0001_node_job_engine', '0002_tpl_node_job_engine', 2_000_000_000_001],
      ['0002_events', '0003_tpl_events', 2_000_000_000_002],
    ],
  )
  const dir = join(project, migrationsPath)
  assert.equal(await readFile(join(dir, '0002_tpl_node_job_engine.sql'), 'utf8'), 'select 2;\n')
  assert.equal(await readFile(join(dir, '0001_superb_excalibur.sql'), 'utf8'), 'select 4;\n')
  const first = JSON.parse(await readFile(join(dir, 'meta/0002_snapshot.json'), 'utf8'))
  const second = JSON.parse(await readFile(join(dir, 'meta/0003_snapshot.json'), 'utf8'))
  assert.equal(first.prevId, 'snap-0001_superb_excalibur')
  assert.equal(second.prevId, first.id)

  // 同一分支上重跑时沿用已移植的文件，不再追加。
  const again = await portMigrations(project, plan.port, target)
  assert.ok(again.every((item) => item.reused))
  const journal = JSON.parse(await readFile(join(dir, 'meta/_journal.json'), 'utf8'))
  assert.equal(journal.entries.length, 4)

  // 已登记（如基准推断后补登记）的迁移不在待移植列表中。
  const recorded = await planMigrations({
    baseCopy: base,
    targetCopy: target,
    recorded: ['0000_init', '0001_node_job_engine'],
  })
  assert.deepEqual(
    recorded.port.map((item) => item.tag),
    ['0002_events'],
  )
})

test('a removed or edited published template migration stops planning', async (t) => {
  const root = await scratch(t)
  await migrations(join(root, 'base'), [['0000_init', 1, 'select 1;\n']])
  await migrations(join(root, 'edited'), [['0000_init', 1, 'select 2;\n']])
  await migrations(join(root, 'removed'), [['0001_other', 2, 'select 1;\n']])
  for (const [name, pattern] of [
    ['edited', /修改了已发布迁移 0000_init/],
    ['removed', /删除了已发布迁移 0000_init/],
  ]) {
    await assert.rejects(
      planMigrations({ baseCopy: join(root, 'base'), targetCopy: join(root, name), recorded: [] }),
      pattern,
    )
  }
})

test('comment-only edits to published template migrations are reported, not fatal', async (t) => {
  const root = await scratch(t)
  await migrations(join(root, 'base'), [
    ['0000_init', 1, 'select 1;--> statement-breakpoint\nselect 2;\n'],
  ])
  await migrations(join(root, 'target'), [
    [
      '0000_init',
      1,
      '-- rollback-safe: 只新增说明\nselect 1;--> statement-breakpoint\nselect 2;\n',
    ],
  ])
  await migrations(join(root, 'inline'), [['0000_init', 1, 'select 1; -- x\nselect 2;\n']])
  const plan = await planMigrations({
    baseCopy: join(root, 'base'),
    targetCopy: join(root, 'target'),
    recorded: [],
  })
  assert.deepEqual(plan.commentOnly, ['0000_init'])
  assert.deepEqual(plan.port, [])
  await assert.rejects(
    planMigrations({
      baseCopy: join(root, 'base'),
      targetCopy: join(root, 'inline'),
      recorded: [],
    }),
    /修改了已发布迁移 0000_init/,
  )
})

test('drizzle-kit output without a result counts as failure even with exit code 0', async (t) => {
  const root = await scratch(t)
  const dir = await migrations(root, [['0000_init', 1, 'select 1;\n']])
  await assert.rejects(
    drizzleGenerate(root, dir, () => ({
      status: 0,
      output: 'Error: Transform failed with 1 error',
    })),
    /drizzle-kit generate 未完成：Error: Transform failed/,
  )
})

test('drizzle-kit generate runs on a temporary copy with the project schema', {
  skip: !existsSync(join(repo, 'packages/db/node_modules/.bin/drizzle-kit')),
  timeout: 120000,
}, async (t) => {
  const dir = join(repo, migrationsPath)
  const before = readFileSync(join(dir, 'meta/_journal.json'), 'utf8')
  assert.equal(await drizzleGenerate(repo, dir, defaultRunner), null)

  const root = await scratch(t)
  const copy = join(root, 'migrations')
  await cp(dir, copy, { recursive: true })
  const journal = JSON.parse(before)
  const last = journal.entries.pop()
  await rm(join(copy, `meta/${last.tag.split('_')[0]}_snapshot.json`))
  await writeFile(join(copy, 'meta/_journal.json'), JSON.stringify(journal))
  const snapshot = await drizzleGenerate(repo, copy, defaultRunner)
  const expected = JSON.parse(
    readFileSync(join(dir, `meta/${last.tag.split('_')[0]}_snapshot.json`), 'utf8'),
  )
  assert.deepEqual(snapshot.tables, expected.tables)
  assert.equal(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'), before)
})

// biome-ignore lint/suspicious/noUndeclaredEnvVars: 直接运行的 Node 测试不经过 Turbo 缓存。
let localUrl = process.env.MIGRATION_DATABASE_URL
const worktreeEnv = join(repo, '.env.worktree')
if (!localUrl && existsSync(worktreeEnv)) {
  localUrl = readFileSync(worktreeEnv, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('MIGRATION_DATABASE_URL='))
    ?.slice('MIGRATION_DATABASE_URL='.length)
}
const isolated =
  localUrl &&
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(localUrl).hostname) &&
  /^saas_(?:wt_|ci)/.test(new URL(localUrl).pathname.slice(1))

/** Temporary data and journal schemas so the probe never touches the real migration history. */
async function pgSchemas(t) {
  const postgres = createRequire(join(repo, 'packages/db/package.json'))('postgres')
  const sql = postgres(localUrl, { max: 1, onnotice: () => {} })
  const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const data = `tpl_sync_data_${suffix}`
  const journal = `tpl_sync_journal_${suffix}`
  await sql.unsafe(`CREATE SCHEMA "${data}"`)
  t.after(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${data}" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${journal}" CASCADE`)
    await sql.end()
  })
  const tables = async () =>
    (
      await sql`select table_name from information_schema.tables where table_schema = ${data} order by 1`
    ).map((row) => row.table_name)
  return { data, journal, tables }
}

test('drizzle-orm skips a migration whose when is not after the last applied one (3.1)', {
  skip: !isolated,
  timeout: 30000,
}, async (t) => {
  const { data, journal, tables } = await pgSchemas(t)
  const root = await scratch(t)
  const table = (name) => `CREATE TABLE "${data}"."${name}" (id int);\n`
  const applied = await migrations(join(root, 'applied'), [
    ['0000_a', 1000, table('a')],
    ['0001_b', 3000, table('b')],
  ])
  const withEarlier = await migrations(join(root, 'earlier'), [
    ['0000_a', 1000, table('a')],
    ['0001_b', 3000, table('b')],
    ['0002_early', 2000, table('early')],
  ])
  const withLater = await migrations(join(root, 'later'), [
    ['0000_a', 1000, table('a')],
    ['0001_b', 3000, table('b')],
    ['0002_early', 2000, table('early')],
    ['0003_late', 4000, table('late')],
  ])
  const early = await migrateIncrementally({
    project: repo,
    url: localUrl,
    before: applied,
    after: withEarlier,
    migrationsSchema: journal,
  })
  assert.deepEqual(early.executed, [])
  assert.deepEqual(await tables(), ['a', 'b'])
  const late = await migrateIncrementally({
    project: repo,
    url: localUrl,
    before: withEarlier,
    after: withLater,
    migrationsSchema: journal,
  })
  assert.deepEqual(late.executed, [4000])
  assert.deepEqual(await tables(), ['a', 'b', 'late'])
})

test('a database at the last project migration executes every ported template migration (3.3)', {
  skip: !isolated,
  timeout: 30000,
}, async (t) => {
  const { data, journal, tables } = await pgSchemas(t)
  const root = await scratch(t)
  const table = (name) => `CREATE TABLE "${data}"."${name}" (id int);\n`
  await migrations(join(root, 'base'), [['0000_init', 1000, table('init')]])
  await migrations(join(root, 'target'), [
    ['0000_init', 1000, table('init')],
    // 模板时间戳早于项目自有迁移：按原样插入会被跳过，移植后应执行。
    ['0001_node_job_engine', 2000, table('job_engine')],
    ['0002_events', 2001, `INSERT INTO "${data}"."job_engine" VALUES (1);\n`],
  ])
  const project = join(root, 'project')
  const dir = await migrations(project, [
    ['0000_init', 1000, table('init')],
    ['0001_superb_excalibur', 5000, table('own')],
  ])
  const plan = await planMigrations({
    baseCopy: join(root, 'base'),
    targetCopy: join(root, 'target'),
    recorded: ['0000_init'],
  })
  const ported = await portMigrations(project, plan.port, join(root, 'target'))
  const before = join(root, 'before')
  await migrationsWithout(
    dir,
    ported.map((item) => item.tag),
    before,
  )
  const result = await migrateIncrementally({
    project: repo,
    url: localUrl,
    before,
    after: dir,
    migrationsSchema: journal,
  })
  assert.equal(result.beforeCount, 2)
  assert.deepEqual(
    result.executed,
    ported.map((item) => item.when),
  )
  assert.deepEqual(await tables(), ['init', 'job_engine', 'own'])
  // 工作区库已有表，同步的 --verify-db 会拒绝它。
  assert.equal(await isEmptyDatabase(repo, localUrl, journal), false)
})
