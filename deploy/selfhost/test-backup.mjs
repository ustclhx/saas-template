import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const full = args.includes('--full')
const devRuntime = args.includes('--dev-runtime')
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const sha = option(
  '--sha',
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
)
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected full SHA')
const sourceDirty = Boolean(
  execFileSync('git', ['status', '--porcelain', '--', 'deploy/selfhost'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
)
const output = resolve(option('--output', join(tmpdir(), `selfhost-d-backup-evidence-${sha}`)))
const temporary = mkdtempSync(join(tmpdir(), 'selfhost-d-backup-'))
chmodSync(temporary, 0o700)
const project = `selfhost-d-backup-${randomBytes(6).toString('hex')}`
const fixture = join(temporary, 'fixture')
const secrets = join(temporary, 'secrets')
const composeFile = join(temporary, 'compose.yaml')
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, COMPOSE_PROFILES: '' }
const image = (name) =>
  process.env[`${name.toUpperCase().replaceAll('-', '_')}_IMAGE`] || `local/selfhost/${name}:${sha}`
const execute = promisify(execFile)
let started = false
let failure
let phase = 'configuration'
let sampling = false
let sampler
let cleaned = false
const events = []
const measurements = {}
const priorCpu = new Map()
const credentials = []
const assert = (condition, reason) => {
  if (!condition) throw new Error(reason)
}
function evidence(event, detail = {}) {
  const value = { event, ...detail }
  events.push(value)
  console.info(JSON.stringify(value))
}
function safe(value) {
  for (const credential of credentials)
    assert(!value.includes(credential), 'Fixture leaked a credential')
  assert(
    !/X-Amz-Signature|postgres(?:ql)?:\/\//i.test(value),
    'Fixture leaked a signed URL or connection string',
  )
  return value
}
function run(command, commandArgs, options = {}) {
  try {
    return safe(
      execFileSync(command, commandArgs, {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: 180_000,
        ...options,
      }),
    )
  } catch (error) {
    if (error.message === 'Fixture leaked a credential') throw error
    const fixtureCode =
      String(error.stderr ?? '').match(/BACKUP_S3_FIXTURE_FAILED_[A-Za-z]+/)?.[0] ?? ''
    const name = commandArgs.includes('/usr/local/lib/selfhost-backup/backup.py')
      ? commandArgs.at(-1)
      : commandArgs.includes('selfhost-walg')
        ? commandArgs
            .slice(
              commandArgs.indexOf('selfhost-walg') + 1,
              commandArgs.indexOf('selfhost-walg') + 3,
            )
            .join(' ')
        : ['s3tool', 'psql', 'pg_restore', 'initdb'].find((name) => commandArgs.includes(name)) ||
          commandArgs[0]
    throw new Error(`Backup acceptance command failed (${fixtureCode} ${phase}; ${name})`)
  }
}
const composeArgs = ['compose', '--env-file', '/dev/null', '-f', composeFile]
const compose = (...commandArgs) => run('docker', [...composeArgs, ...commandArgs])
async function composeAsync(...commandArgs) {
  try {
    const result = await execute('docker', [...composeArgs, ...commandArgs], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    })
    return safe(result.stdout)
  } catch {
    throw new Error(`Backup acceptance asynchronous command failed (${phase})`)
  }
}
function secret(name) {
  const value = randomBytes(32).toString('hex')
  credentials.push(value)
  writeFileSync(join(secrets, name), value, { mode: 0o644 })
}
async function wait(check, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(1000)
  }
  throw new Error(`Backup acceptance timed out (${phase})`)
}
const sql = (query, service = 'postgres', database = 'saas_production') =>
  compose(
    'exec',
    '-T',
    service,
    'psql',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    database,
    '-tAc',
    query,
  ).trim()
const walg = (...commandArgs) => compose('exec', '-T', 'backup', 'selfhost-walg', ...commandArgs)
const backup = (...commandArgs) =>
  compose(
    'exec',
    '-T',
    'backup',
    'python3',
    '/usr/local/lib/selfhost-backup/backup.py',
    ...commandArgs,
  )
const status = () => JSON.parse(backup('status'))
const s3 = (...commandArgs) =>
  JSON.parse(compose('run', '--rm', '--no-deps', 's3tool', ...commandArgs))
function rejectBackup(overrides, command = 'status', entrypoint) {
  const commandArgs = ['run', '--rm', '--no-deps']
  for (const [name, value] of Object.entries(overrides)) commandArgs.push('-e', `${name}=${value}`)
  if (entrypoint) commandArgs.push('--entrypoint', entrypoint)
  commandArgs.push('backup', ...(entrypoint ? ['backup-list', '--json'] : [command]))
  let rejected = false
  try {
    compose(...commandArgs)
  } catch {
    rejected = true
  }
  assert(rejected, 'Invalid configuration or failed operation returned success')
}
async function pitr(backupId, target) {
  await composeAsync('stop', 'restore')
  compose('rm', '-f', 'restore')
  run('docker', ['volume', 'rm', `${project}_restored`, `${project}_restore_socket`])
  compose(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'selfhost-walg',
    'restore',
    'backup-fetch',
    '/var/lib/postgresql/data',
    backupId,
  )
  const config = `restore_command = 'selfhost-walg wal-fetch %f %p'\nrecovery_target_time = '${target}'\nrecovery_target_timeline = '1'\nrecovery_target_action = 'pause'\nrecovery_target_inclusive = true\n`
  run(
    'docker',
    [
      ...composeArgs,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'sh',
      'restore',
      '-c',
      'cat >> /var/lib/postgresql/data/postgresql.auto.conf; touch /var/lib/postgresql/data/recovery.signal',
    ],
    { input: config },
  )
  await composeAsync('up', '-d', 'restore')
  await wait(() => {
    try {
      return sql('select pg_is_wal_replay_paused()', 'restore') === 't'
    } catch {
      return false
    }
  })
}
async function sample() {
  measurements[phase] ??= {
    samples: 0,
    services: {},
    maxConnections: 0,
    maxWalBytes: 0,
    maxPgDataBytes: 0,
    minFreeBytes: null,
  }
  const point = measurements[phase]
  for (const service of ['postgres', 'backup', 'object-storage', 'tls']) {
    let result
    try {
      result = compose(
        'exec',
        '-T',
        service,
        'sh',
        '-c',
        "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat; awk '/^VmRSS:/ {s += $2} END {print s*1024}' /proc/[0-9]*/status 2>/dev/null || true",
      )
    } catch (error) {
      if (service === 'tls' && phase === 'archive_upload_failure') continue
      throw error
    }
    const lines = result.trim().split('\n')
    point.services[service] ??= {
      rssPeakBytes: 0,
      cgroupPeakBytes: 0,
      cpuUsec: 0,
      cpuPeakPercent: 0,
    }
    const value = point.services[service]
    value.rssPeakBytes = Math.max(value.rssPeakBytes, Number(lines.at(-1)))
    value.cgroupPeakBytes = Math.max(value.cgroupPeakBytes, Number(lines[1]))
    value.cpuUsec = Number(result.match(/usage_usec (\d+)/)?.[1])
    const measuredAt = Date.now()
    const prior = priorCpu.get(service)
    if (prior)
      value.cpuPeakPercent = Math.max(
        value.cpuPeakPercent,
        (value.cpuUsec - prior.usage) / ((measuredAt - prior.at) * 10),
      )
    priorCpu.set(service, { usage: value.cpuUsec, at: measuredAt })
    assert(/oom_kill 0\b/.test(result), 'Fixture resource budget OOM')
  }
  const metrics = JSON.parse(
    sql(
      "select json_build_object('connections',(select count(*) from pg_stat_activity),'walBytes',(select coalesce(sum(size),0) from pg_ls_waldir()),'pgDataBytes',pg_database_size(current_database()))",
    ),
  )
  point.maxConnections = Math.max(point.maxConnections, metrics.connections)
  point.maxWalBytes = Math.max(point.maxWalBytes, metrics.walBytes)
  point.maxPgDataBytes = Math.max(point.maxPgDataBytes, metrics.pgDataBytes)
  const disk = status().disk
  point.minFreeBytes = Math.min(point.minFreeBytes ?? disk.freeBytes, disk.freeBytes)
  point.maxPgDataBytes = Math.max(point.maxPgDataBytes, disk.pgDataBytes)
  point.samples++
}
async function monitor() {
  while (sampling) {
    if (phase !== 'schedule_restart') await sample()
    await delay(1000)
  }
}
async function cleanup() {
  sampling = false
  if (sampler) await sampler.catch(() => {})
  try {
    if (started) compose('down', '-v', '--remove-orphans', '--timeout', '10')
    cleaned = true
  } catch {
    failure ??= 'Backup acceptance cleanup failed'
  }
  rmSync(temporary, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    failure = `Backup acceptance interrupted by ${signal}`
    await cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })

try {
  mkdirSync(secrets)
  mkdirSync(fixture)
  for (const name of [
    'postgres_password',
    'app_db_password',
    'migrator_db_password',
    'readonly_db_password',
    's3_admin_access_key_id',
    's3_admin_secret_access_key',
    's3_access_key_id',
    's3_secret_access_key',
  ])
    secret(name)
  writeFileSync(
    join(secrets, 'migrator_database_url'),
    `postgres://migrator:${readFileSync(join(secrets, 'migrator_db_password'), 'utf8')}@postgres:5432/saas_production?sslmode=verify-full`,
    { mode: 0o644 },
  )
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(fixture, 'ca.key'),
    '-out',
    join(fixture, 'ca.crt'),
    '-days',
    '2',
    '-subj',
    '/CN=selfhost-d-backup-CA',
  ])
  writeFileSync(
    join(fixture, 'extensions'),
    'subjectAltName=DNS:tls,DNS:postgres\nextendedKeyUsage=serverAuth\n',
  )
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(fixture, 'server.key'),
    '-out',
    join(fixture, 'server.csr'),
    '-subj',
    '/CN=tls',
  ])
  run('openssl', [
    'x509',
    '-req',
    '-in',
    join(fixture, 'server.csr'),
    '-CA',
    join(fixture, 'ca.crt'),
    '-CAkey',
    join(fixture, 'ca.key'),
    '-CAcreateserial',
    '-out',
    join(fixture, 'server.crt'),
    '-days',
    '2',
    '-extfile',
    join(fixture, 'extensions'),
  ])
  chmodSync(join(fixture, 'server.key'), 0o644)
  writeFileSync(join(fixture, 'ca-invalid.crt'), 'invalid fixture certificate\n')
  const schedulingTime = new Date(Date.now() - 60_000).toISOString().slice(11, 16)
  // 只有脚本创建的 project、卷和内网；测试不采纳外部 S3 配置、不暴露宿主端口。
  writeFileSync(
    composeFile,
    `
name: '${project}'
x-safe: &safe
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  networks: [fixture]
  logging: {driver: json-file, options: {max-size: 2m, max-file: '2'}}
x-backup-env: &backup-env
  PGHOST: /var/run/postgresql
  PGUSER: postgres
  POSTGRES_DB: saas_production
  PGDATA: /var/lib/postgresql/data
  BACKUP_S3_ENDPOINT: https://tls:8443
  BACKUP_S3_REGION: us-east-1
  BACKUP_S3_PREFIX: s3://backup-fixture/cluster
  BACKUP_S3_FORCE_PATH_STYLE: 'true'
  BACKUP_S3_CA_FILE: /fixture/ca.crt
  BACKUP_S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_admin_access_key_id
  BACKUP_S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_admin_secret_access_key
services:
  postgres:
    <<: *safe
    image: '${image('postgres')}'
    user: '999:999'
    mem_limit: 1g
    cpus: 0.5
    environment:
      <<: *backup-env
      BACKUP_ENABLED: 'true'
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
      APP_DB_PASSWORD_FILE: /run/secrets/app_db_password
      MIGRATOR_DB_PASSWORD_FILE: /run/secrets/migrator_db_password
      READONLY_DB_PASSWORD_FILE: /run/secrets/readonly_db_password
    secrets: [postgres_password, app_db_password, migrator_db_password, readonly_db_password, s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [pgdata:/var/lib/postgresql/data, socket:/var/run/postgresql, backup_state:/var/lib/selfhost-backup, '${fixture}:/fixture:ro', '${fixture}:/etc/postgresql/tls-src:ro']
    healthcheck: {test: [CMD, pg_isready, -U, postgres, -d, saas_production], interval: 2s, timeout: 3s, retries: 60}
  backup:
    <<: *safe
    image: '${image('backup')}'
    user: '999:999'
    restart: unless-stopped
    mem_limit: 256m
    cpus: 0.2
    environment:
      <<: *backup-env
      BACKUP_UTC_TIME: '${schedulingTime}'
      BACKUP_RETRY_SECONDS: '3'
    # 先暂停调度，seed 后再以正式 schedule 入口重建。
    entrypoint: [python3, /usr/local/lib/selfhost-backup/backup.py]
    command: [schedule]
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [pgdata:/var/lib/postgresql/data:ro, socket:/var/run/postgresql, backup_state:/var/lib/selfhost-backup, '${fixture}:/fixture:ro'${devRuntime ? `, '${join(root, 'deploy/selfhost/backup')}:/usr/local/lib/selfhost-backup:ro'` : ''}]
  object-storage:
    <<: *safe
    image: '${image('object-storage')}'
    user: '1000:1000'
    mem_limit: 512m
    cpus: 0.3
    environment:
      S3_PUBLIC_DOMAIN: tls
      S3_BUCKET: backup-fixture
      S3_ADMIN_ACCESS_KEY_ID_FILE: /run/secrets/s3_admin_access_key_id
      S3_ADMIN_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_admin_secret_access_key
      S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_access_key_id
      S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_secret_access_key
      GOMEMLIMIT: 384MiB
      GOMAXPROCS: '1'
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key, s3_access_key_id, s3_secret_access_key]
    volumes: [objects:/data, metadata:/metadata]
    tmpfs: ['/tmp:uid=1000,gid=1000,mode=0700']
    healthcheck: {test: [CMD, /usr/local/bin/object-storage-health], interval: 2s, timeout: 3s, retries: 60}
  tls:
    <<: *safe
    image: '${image('migrate')}'
    user: '1000:1000'
    mem_limit: 128m
    cpus: 0.1
    entrypoint: [node, /src/deploy/selfhost/backup/acceptance-s3.mjs]
    command: [proxy]
    volumes: ['${fixture}:/fixture:ro', '${join(root, 'deploy/selfhost/backup/acceptance-s3.mjs')}:/src/deploy/selfhost/backup/acceptance-s3.mjs:ro']
  migrate:
    <<: *safe
    image: '${image('migrate')}'
    user: '1000:1000'
    mem_limit: 512m
    cpus: 0.3
    environment:
      MIGRATION_DATABASE_URL_FILE: /run/secrets/migrator_database_url
      NODE_EXTRA_CA_CERTS: /fixture/ca.crt
      DBOS_APPLICATION_ROLE: app
      DBOS_READONLY_ROLE: readonly
    secrets: [migrator_database_url]
    volumes: ['${fixture}:/fixture:ro']
  s3tool:
    <<: *safe
    image: '${image('migrate')}'
    user: '1000:1000'
    mem_limit: 256m
    cpus: 0.2
    entrypoint: [node, /src/deploy/selfhost/backup/acceptance-s3.mjs]
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: ['${join(root, 'deploy/selfhost/backup/acceptance-s3.mjs')}:/src/deploy/selfhost/backup/acceptance-s3.mjs:ro']
  restore:
    <<: *safe
    image: '${image('postgres')}'
    user: '999:999'
    mem_limit: 512m
    cpus: 0.3
    entrypoint: [postgres]
    command: [-c, "listen_addresses=", -c, ssl=off, -c, archive_mode=off, -c, hba_file=/etc/postgresql/pg_hba.conf]
    environment: *backup-env
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [restored:/var/lib/postgresql/data, restore_socket:/var/run/postgresql, backup_state:/backup-artifacts:ro, '${fixture}:/fixture:ro']
networks:
  fixture: {internal: true}
volumes:
  pgdata: {}
  socket: {}
  backup_state: {}
  objects: {}
  metadata: {}
  restored: {}
  restore_socket: {}
secrets:
  migrator_database_url: {file: '${join(secrets, 'migrator_database_url')}'}
${credentials
  .map(
    (_, i) =>
      [
        'postgres_password',
        'app_db_password',
        'migrator_db_password',
        'readonly_db_password',
        's3_admin_access_key_id',
        's3_admin_secret_access_key',
        's3_access_key_id',
        's3_secret_access_key',
      ][i],
  )
  .map((name) => `  ${name}: {file: '${join(secrets, name)}'}`)
  .join('\n')}
`,
  )
  const config = JSON.parse(compose('config', '--format', 'json'))
  assert(
    Object.values(config.services).every((s) => !s.ports?.length && !s.build),
    'Fixture exposes data ports or builds',
  )
  assert(config.networks.fixture.internal, 'Fixture permits external egress')
  for (const name of ['postgres', 'backup', 'object-storage', 'migrate']) {
    const [info] = JSON.parse(run('docker', ['image', 'inspect', image(name)]))
    assert(
      info.Config.User && !['0', 'root'].includes(info.Config.User.split(':')[0]),
      'Fixture image is root',
    )
  }
  evidence('backup.fixture', {
    mode: full ? 'full' : 'smoke',
    project,
    noPublishedPorts: true,
    internalOnly: true,
  })
  phase = 'startup'
  started = true
  await composeAsync(
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '120',
    'postgres',
    'object-storage',
    'tls',
  )
  phase = 'bucket_initialization'
  s3('init')
  evidence('backup.bucket_ready')
  phase = 'migrations'
  const migration = compose('run', '--rm', '--no-deps', 'migrate')
  assert(
    migration.includes('selfhost.db:migrate.completed') &&
      migration.includes('selfhost.dbos:migrate.completed'),
    'Production schema migration failed',
  )
  evidence('backup.production_schemas', { businessSql: true, dbosMigrate: true })
  phase = 'seed'
  sql(`set role migrator;
    create table public.backup_marker(id text primary key, amount integer not null check(amount >= 0));
    create schema if not exists job_engine authorization migrator;
    create schema if not exists dbos authorization migrator;
    create table job_engine.backup_task(id text primary key, status text not null);
    create table dbos.backup_task(id text primary key, status text not null);
    grant usage on schema job_engine, dbos to app, readonly;
    grant select, insert, update, delete on all tables in schema job_engine, dbos to app;
    grant select on all tables in schema job_engine, dbos to readonly;
    insert into public.backup_marker values ('before', 17);
    insert into job_engine.backup_task values ('fixture', 'pending');
    insert into dbos.backup_task values ('fixture', 'pending');`)
  // 启动前做配置边界，防止失败测试与生产式调度互相覆盖状态。
  phase = 'configuration_boundaries'
  rejectBackup({ BACKUP_S3_ACCESS_KEY_ID_FILE: '/fixture/missing' }, 'base')
  rejectBackup({ BACKUP_S3_ACCESS_KEY_ID: 'fixture-conflict' }, 'base')
  rejectBackup({ BACKUP_S3_CA_FILE: '/fixture/ca-invalid.crt' }, 'base')
  rejectBackup({ BACKUP_S3_CA_FILE: '' }, 'base')
  compose(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'selfhost-walg',
    'backup',
    'backup-list',
    '--json',
  )
  evidence('backup.configuration', {
    fileSecretsNonRoot: true,
    missingFileRejected: true,
    fileValueConflictRejected: true,
    invalidTlsRejected: true,
    selfSignedCaVerified: true,
  })
  phase = 'scheduled_cycle'
  await composeAsync('up', '-d', 'backup')
  assert(compose('exec', '-T', 'backup', 'id', '-u').trim() === '999', 'Backup runtime UID differs')
  sampling = true
  sampler = monitor().catch((error) => {
    sampling = false
    failure = `Backup resource sampling failed: ${error.message}`
  })
  await wait(() => {
    const value = status()
    return value.base?.ok && value.dump?.ok && value.schedule?.lastSuccess
  }, 180_000)
  const runtimeUid = Number(
    compose('exec', '-T', 'backup', 'cat', '/proc/1/status').match(/^Uid:\s+(\d+)/m)?.[1],
  )
  assert(runtimeUid === 999, 'Backup PID1 UID differs')
  const schemaSql =
    "select json_agg(table_schema || '.' || table_name order by table_schema,table_name) from information_schema.tables where table_schema in ('public','job_engine','dbos','drizzle')"
  const sourceSchemas = sql(schemaSql)
  const aclSql =
    'select json_agg(json_build_array(grantor::regrole::text,grantee::regrole::text,privilege_type,is_grantable) order by grantor,grantee,privilege_type,is_grantable) from pg_database cross join lateral aclexplode(datacl) where datname=current_database()'
  const sourceDbAcl = sql(aclSql)
  const first = status()
  assert(first.healthy, 'Successful cycle reported unhealthy')
  backup('health')
  const backups = JSON.parse(walg('backup-list', '--json'))
  assert(backups.length >= 1 && first.base.backupId, 'No real base backup')
  const objects = s3('list')
  assert(
    objects.some((o) => /basebackups_005\/.*_backup_stop_sentinel\.json$/.test(o.key)),
    'S3 base sentinel absent',
  )
  sql('select pg_switch_wal()')
  await wait(() => Number(sql('select archived_count from pg_stat_archiver')) > 0)
  assert(
    s3('list').some((o) => /wal_005\/[0-9A-F]{24}/.test(o.key)),
    'No real S3 WAL',
  )
  evidence('backup.real_cycle', {
    baseCount: backups.length,
    walArchived: true,
    dumpUploaded: true,
    scheduleSlot: first.schedule.slot,
    runtimeUid,
    healthy: first.healthy,
  })
  phase = 'logical_restore'
  const manifestKey = s3('list').find((o) => /logical\/.*\/manifest\.json$/.test(o.key))?.key
  assert(manifestKey, 'Logical manifest missing')
  const logicalPrefix = manifestKey.slice('cluster/'.length).replace(/manifest\.json$/, '')
  compose(
    'exec',
    '-T',
    'backup',
    'sh',
    '-c',
    'mkdir -p /var/lib/selfhost-backup/acceptance && chmod 700 /var/lib/selfhost-backup/acceptance',
  )
  walg(
    'st',
    'get',
    `${logicalPrefix}database.dump.lz4`,
    '/var/lib/selfhost-backup/acceptance/database.dump',
  )
  walg(
    'st',
    'get',
    `${logicalPrefix}roles.sql.lz4`,
    '/var/lib/selfhost-backup/acceptance/roles.sql',
  )
  const dumpList = compose(
    'exec',
    '-T',
    'backup',
    'pg_restore',
    '--list',
    '/var/lib/selfhost-backup/acceptance/database.dump',
  )
  assert(
    ['public backup_marker', 'job_engine backup_task', 'dbos backup_task'].every((name) =>
      dumpList.includes(name),
    ),
    'Dump does not cover all schemas',
  )
  compose(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'initdb',
    'restore',
    '-D',
    '/var/lib/postgresql/data',
    '--auth-local=peer',
    '--auth-host=scram-sha-256',
  )
  await composeAsync('up', '-d', 'restore')
  await wait(() => {
    try {
      return sql('select 1', 'restore', 'postgres') === '1'
    } catch {
      return false
    }
  })
  const roles = compose(
    'exec',
    '-T',
    'backup',
    'cat',
    '/var/lib/selfhost-backup/acceptance/roles.sql',
  )
  assert(
    ['app', 'migrator', 'readonly'].every((role) => roles.includes(`CREATE ROLE ${role};`)),
    'Role restoration material absent',
  )
  run(
    'docker',
    [
      ...composeArgs,
      'exec',
      '-T',
      'restore',
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: roles },
  )
  compose(
    'exec',
    '-T',
    'restore',
    'pg_restore',
    '--create',
    '--exit-on-error',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '/backup-artifacts/acceptance/database.dump',
  )
  const checkSql = `select json_build_object('marker',(select amount from public.backup_marker where id='before'),'job',(select status from job_engine.backup_task where id='fixture'),'dbos',(select status from dbos.backup_task where id='fixture'),'appDml',has_table_privilege('app','public.backup_marker','INSERT'),'readonlySelect',has_table_privilege('readonly','public.backup_marker','SELECT'),'readonlyWrite',has_table_privilege('readonly','public.backup_marker','INSERT'),'appSuper',(select rolsuper from pg_roles where rolname='app'),'appCreate',has_schema_privilege('app','public','CREATE'),'migratorCreate',has_schema_privilege('migrator','public','CREATE'))`
  assert(
    sql(schemaSql, 'restore') === sourceSchemas,
    'Actual business/engine schema inventory differs',
  )
  assert(sql(aclSql, 'restore') === sourceDbAcl, 'Database ACL differs')
  const restored = JSON.parse(sql(checkSql, 'restore'))
  assert(
    restored.marker === 17 &&
      restored.job === 'pending' &&
      restored.dbos === 'pending' &&
      restored.appDml &&
      restored.readonlySelect &&
      !restored.readonlyWrite &&
      !restored.appSuper &&
      !restored.appCreate &&
      restored.migratorCreate,
    'Logical restore data or role permissions differ',
  )
  evidence('backup.logical_restore', {
    customFormatList: true,
    ...restored,
    roleMaterial: true,
    databaseAcl: true,
    productionSchemas: true,
  })
  phase = 'schedule_restart'
  await composeAsync('restart', 'backup')
  await delay(4000)
  const afterRestart = status()
  assert(
    afterRestart.schedule.slot === first.schedule.slot &&
      afterRestart.schedule.lastSuccess === first.schedule.lastSuccess &&
      afterRestart.base.backupId === first.base.backupId,
    'Restart duplicated successful schedule slot',
  )
  evidence('backup.schedule_restart', { successfulSlotPreserved: true, noDuplicateBase: true })
  if (full) {
    phase = 'oldest_weekly_pitr'
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'base',
    )
    const weeklyId = status().base.backupId
    const beforeTarget = sql(
      "select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'",
    )
    await delay(1500)
    sql("insert into public.backup_marker values ('after', 99)")
    sql('select pg_switch_wal()')
    await wait(
      () =>
        !Number(
          sql(
            "select count(*) from pg_ls_dir('pg_wal/archive_status') as name where name like '%.ready'",
          ),
        ),
    )
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'base',
    )
    const all = JSON.parse(walg('backup-list', '--json'))
    const oldest = all.find((b) => (b.backup_name ?? b.BackupName) === weeklyId)
    assert(oldest, 'Oldest base missing before retention')
    const oldestKey = s3('list').find((o) => o.key.endsWith(`/${weeklyId}/metadata.json`))?.key
    assert(oldestKey, 'Oldest base sentinel missing')
    const weeklyDate = new Date(Date.now() - 21 * 86400_000)
    weeklyDate.setUTCDate(weeklyDate.getUTCDate() - ((weeklyDate.getUTCDay() + 6) % 7))
    weeklyDate.setUTCHours(2, 0, 0, 0)
    const obsoleteKey = s3('list').find((o) =>
      o.key.endsWith(`/${first.base.backupId}/metadata.json`),
    )?.key
    s3('age', obsoleteKey, new Date(Date.now() - 40 * 86400_000).toISOString())
    s3('age', oldestKey, weeklyDate.toISOString())
    backup('verify')
    // 删除缺段只能在本fixture发生；恢复原始压缩对象后才继续真实清理。
    const gapKey = s3('list').find((o) => o.key.endsWith(`/wal_005/${weeklyId.slice(5)}.lz4`))?.key
    assert(gapKey, 'Weekly WAL absent before gap injection')
    const relativeGap = gapKey.slice('cluster/'.length)
    walg('st', 'get', relativeGap, '/var/lib/selfhost-backup/acceptance/gap.lz4', '--no-decompress')
    walg('st', 'rm', relativeGap)
    const beforeGapApply = s3('list')
    let gapRejected = false
    try {
      backup('retention-apply')
    } catch {
      gapRejected = true
    }
    assert(
      gapRejected && JSON.stringify(beforeGapApply) === JSON.stringify(s3('list')),
      'Gap permitted destructive cleanup',
    )
    walg('st', 'put', '/var/lib/selfhost-backup/acceptance/gap.lz4', relativeGap, '--no-compress')
    evidence('backup.gap_protection', { missingWalRejected: true, noDelete: true })
    const beforeCleanup = s3('list')
    const plan = JSON.parse(backup('retention-plan'))
    assert(plan.oldest === weeklyId && plan.weekly.includes(weeklyId), 'Weekly selection differs')
    assert(JSON.stringify(beforeCleanup) === JSON.stringify(s3('list')), 'Dry-run mutated S3')
    backup('retention-apply')
    assert(
      !JSON.parse(walg('backup-list', '--json')).some((b) => b.backup_name === first.base.backupId),
      'Obsolete base was not deleted',
    )
    assert(
      s3('list').some((o) => o.key.includes(`wal_005/${weeklyId.slice(5)}`)),
      'Weekly starting WAL deleted',
    )
    assert(
      JSON.parse(walg('backup-list', '--json')).some(
        (b) => (b.backup_name ?? b.BackupName) === weeklyId,
      ),
      'Weekly anchor deleted by real retention',
    )
    const restoreStart = Date.now()
    await pitr(weeklyId, beforeTarget)
    assert(
      sql("select string_agg(id,',' order by id) from public.backup_marker", 'restore') ===
        'before',
      'PITR before/after marker incorrect',
    )
    assert(JSON.parse(sql(checkSql, 'restore')).marker === 17, 'PITR roles/tasks missing')
    sql('select pg_wal_replay_resume()', 'restore')
    sql('select pg_promote(true, 30)', 'restore')
    compose(
      'exec',
      '-T',
      'restore',
      'sh',
      '-c',
      'selfhost-walg wal-push /var/lib/postgresql/data/pg_wal/00000002.history',
    )
    assert(
      s3('list').some((o) => /wal_005\/00000002\.history/.test(o.key)),
      'Real timeline history missing',
    )
    evidence('backup.oldest_weekly_pitr', {
      backupId: weeklyId,
      retentionDateSimulated: true,
      retainedAgeDays: 21,
      realTarget: beforeTarget,
      beforePresent: true,
      afterAbsent: true,
      historyArchived: true,
      elapsedMs: Date.now() - restoreStart,
    })
    // 不再写业务数据：按工具公布的采样上界恢复，验证空闲库也能命中target_time。
    const idleBound = status().verification.continuousUntil
    await pitr(weeklyId, idleBound)
    assert(
      sql("select string_agg(id,',' order by id) from public.backup_marker", 'restore') ===
        'after,before',
      'Idle verified upper bound was not reached',
    )
    evidence('backup.idle_upper_bound', {
      target: idleBound,
      reached: true,
      businessWritesAfterVerify: false,
    })
    phase = 'disk_failure'
    rejectBackup({ BACKUP_MIN_FREE_BYTES: '9223372036854775807' }, 'dump')
    let current = status()
    assert(
      current.dump.failures > first.dump.failures && !current.dump.ok,
      'Disk failure absent from status',
    )
    const pendingTemp = compose(
      'exec',
      '-T',
      'backup',
      'sh',
      '-c',
      'find /var/lib/selfhost-backup/tmp -type f | wc -l',
    ).trim()
    assert(pendingTemp === '0', 'Failed dump retained temporary files')
    evidence('backup.disk_failure', { nonzero: true, statusFailed: true, temporaryFiles: 0 })
    phase = 'archive_upload_failure'
    const failuresBefore = Number(sql('select failed_count from pg_stat_archiver'))
    await composeAsync('stop', 'tls')
    sql("insert into public.backup_marker values ('archive_failure', 1)")
    sql('select pg_switch_wal()')
    await wait(() => Number(sql('select failed_count from pg_stat_archiver')) > failuresBefore)
    assert(
      Number(
        sql(
          "select count(*) from pg_ls_dir('pg_wal/archive_status') as name where name like '%.ready'",
        ),
      ) > 0,
      'Unarchived WAL removed after failure',
    )
    const beforeFailedBase = s3('list')
    rejectBackup({}, 'base')
    rejectBackup({}, 'dump')
    let cleanupRejected = false
    try {
      backup('retention-apply')
    } catch {
      cleanupRejected = true
    }
    assert(
      cleanupRejected && JSON.stringify(beforeFailedBase) === JSON.stringify(s3('list')),
      'Failed new base allowed delete',
    )
    current = status()
    assert(
      !current.dump.ok &&
        current.dump.failures > first.dump.failures &&
        current.pgStatArchiver.failed_count > failuresBefore,
      'Upload/archive failure missing from status',
    )
    evidence('backup.archive_upload_failure', {
      nonzero: true,
      unarchivedWalRetained: true,
      archiverFailuresIncreased: true,
      dumpStatusFailed: true,
      newBaseFailed: !current.base.ok,
      failedCycleNoDelete: true,
    })
    await composeAsync('start', 'tls')
    // PostgreSQL 自然重试；不伪写成功状态或移除 .ready 文件。
    await wait(
      () =>
        !Number(
          sql(
            "select count(*) from pg_ls_dir('pg_wal/archive_status') as name where name like '%.ready'",
          ),
        ),
      90_000,
    )
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'dump',
    )
    assert(status().dump.ok, 'Dump did not recover after endpoint restored')
    evidence('backup.failure_recovery', { archiveRetried: true, dumpRecovered: true })
  }
  sampling = false
  await sampler
  assert(!failure, failure)
  const final = status()
  assert(final.disk.freeBytes > 0 && final.disk.walBytes > 0, 'Status disk/WAL evidence absent')
  for (const point of Object.values(measurements)) {
    assert(point.maxConnections <= 10, 'Backup connection budget exceeded')
    for (const [name, resource] of Object.entries(point.services)) {
      assert(
        resource.cgroupPeakBytes <= config.services[name].mem_limit,
        'Backup memory budget exceeded',
      )
    }
  }
  evidence('backup.resources', {
    budgets: { fixtureMiB: 2432, backupMiB: 256, backupCpu: 0.2, maxConnections: 10 },
    measurements,
    disk: final.disk,
  })
  phase = 'redaction'
  safe(compose('logs', '--no-log-prefix', 'postgres', 'backup', 'object-storage', 'tls'))
  evidence('backup.passed', { full })
} catch (error) {
  failure = error instanceof Error ? error.message : 'Backup acceptance failed'
  if (started) {
    try {
      evidence('backup.failure_status', { status: status() })
    } catch {}
  }
  evidence('backup.failed', { phase, reason: failure })
} finally {
  await cleanup()
  mkdirSync(output, { recursive: true })
  writeFileSync(
    join(output, 'backup-smoke.json'),
    `${JSON.stringify({ sha, sourceDirty, full, passed: !failure, cleaned, events, measurements }, null, 2)}\n`,
  )
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
