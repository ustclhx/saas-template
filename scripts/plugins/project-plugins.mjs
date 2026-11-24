import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configCall, staticCollection, staticConstants, staticValue } from './static-config.mjs'

// 生成器也运行在未安装依赖的模板快照中，只读取生成所需的静态清单字段。
export async function loadProjectPlugins(root) {
  const plugins = join(root, 'plugins')
  const entries = await readdir(plugins, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const manifests = []
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(plugins, entry.name, 'plugin.ts')
    const source = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (source === null) continue
    try {
      const { members, start } = configCall(source, 'definePlugin')
      const constants = staticConstants(source.slice(0, start))
      const manifest = Object.fromEntries(
        members
          .filter(({ key }) => ['id', 'targets', 'requires', 'bindings', 'secrets'].includes(key))
          .map(({ key, valueStart, end }) => [
            key,
            staticValue(source.slice(valueStart, end), constants),
          ]),
      )
      if (manifest.id !== entry.name) throw new Error(`清单 id 应为 ${entry.name}`)
      manifests.push(manifest)
    } catch (error) {
      throw new Error(`plugins/${entry.name}/plugin.ts：${error.message}`, { cause: error })
    }
  }
  return manifests
}

const wranglerBindings = {
  ai: ['ai'],
  durable_object: ['durable_objects', 'bindings'],
  hyperdrive: ['hyperdrive'],
  kv: ['kv_namespaces'],
  queue: ['queues', 'producers'],
  r2: ['r2_buckets'],
  rate_limit: ['ratelimits'],
  service: ['services'],
  workflow: ['workflows'],
}

function removalEdits(collection, removed) {
  const edits = []
  const { members } = collection
  for (let index = 0; index < members.length; index++) {
    if (!removed.has(members[index])) continue
    const first = index
    while (removed.has(members[index + 1])) index++
    const last = members[index]
    const before = members[first - 1]
    if (last.comma === undefined && before) {
      edits.push({ start: before.comma, end: before.comma + 1, value: '' })
    }
    edits.push({
      start: members[first].start,
      end: last.comma === undefined ? last.end : last.comma + 1,
      value: '',
    })
  }
  return edits
}

function applyEdits(source, edits) {
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, { start, end, value }) => text.slice(0, start) + value + text.slice(end), source)
}

function dropBindingKind(source, scopePath, fieldPath, names, nameKey) {
  const parents = []
  let collection = staticCollection(source)
  for (const key of [...scopePath, ...fieldPath]) {
    const field = collection.members.find((member) => member.key === key)
    if (!field) return source
    parents.push({ collection, field })
    collection = staticCollection(source, field.valueStart)
  }
  const bindingName = ({ valueStart, end }) => staticValue(source.slice(valueStart, end))[nameKey]
  const { field } = parents.at(-1)
  if (source[field.valueStart] === '[') {
    const removed = new Set(collection.members.filter((member) => names.has(bindingName(member))))
    if (!removed.size) return source
    if (removed.size < collection.members.length) {
      return applyEdits(source, removalEdits(collection, removed))
    }
  } else if (!names.has(bindingName(field))) return source

  // 整段只含停用绑定时可删除字段；共享的 queues 等容器保留其他配置。
  let index = parents.length - 1
  while (index > scopePath.length && parents[index].collection.members.length === 1) index--
  return applyEdits(
    source,
    removalEdits(parents[index].collection, new Set([parents[index].field])),
  )
}

// 从目标类向前追溯迁移，删除同一个 Durable Object 的旧类名及其创建操作。
const migrationOperations = [
  'transferred_classes',
  'new_sqlite_classes',
  'new_classes',
  'renamed_classes',
  'deleted_classes',
]

function pruneMigration(source, disabledClasses, historicalClasses) {
  const migration = staticCollection(source)
  const removed = new Set()
  const edits = []
  let hasRetainedOperation = false
  for (const kind of migrationOperations) {
    const field = migration.members.find(({ key }) => key === kind)
    if (!field) continue
    const operations = staticCollection(source, field.valueStart)
    const omitted = new Set()
    for (const operation of operations.members.toReversed()) {
      const value = staticValue(source.slice(operation.valueStart, operation.end))
      if (kind === 'deleted_classes') {
        if (!disabledClasses.has(value)) continue
        historicalClasses.add(value)
      } else {
        const target = typeof value === 'string' ? value : value.to
        if (!historicalClasses.delete(target)) continue
        if (kind === 'renamed_classes') historicalClasses.add(value.from)
      }
      omitted.add(operation)
    }
    if (omitted.size < operations.members.length) hasRetainedOperation = true
    if (!omitted.size) continue
    if (omitted.size === operations.members.length) removed.add(field)
    else edits.push(...removalEdits(operations, omitted))
  }
  if (!removed.size && !edits.length) return source
  return hasRetainedOperation
    ? applyEdits(source, [...edits, ...removalEdits(migration, removed)])
    : null
}

function pruneMigrations(source, scope, classes, inheritsRootMigrations = false) {
  if (!classes.size) return source
  let collection = staticCollection(source)
  for (const key of scope) {
    const field = collection.members.find((member) => member.key === key)
    collection = staticCollection(source, field.valueStart)
  }
  const field = collection.members.find(({ key }) => key === 'migrations')
  if (!field) return source
  const migrations = staticCollection(source, field.valueStart)
  const removed = new Set()
  const edits = []
  const historicalClasses = new Set(classes)
  for (const migration of migrations.members.toReversed()) {
    const original = source.slice(migration.valueStart, migration.end)
    const value = pruneMigration(original, classes, historicalClasses)
    if (value === null) removed.add(migration)
    else if (value !== original)
      edits.push({ start: migration.valueStart, end: migration.end, value })
  }
  if (!edits.length && !removed.size) return source
  // Wrangler 环境移除空数组后会继承根迁移，保留原有的覆盖行为。
  if (!inheritsRootMigrations && removed.size === migrations.members.length) {
    return applyEdits(source, removalEdits(collection, new Set([field])))
  }
  return applyEdits(source, [...edits, ...removalEdits(migrations, removed)])
}

function unusedClasses(classes, configs) {
  const unused = new Set(classes)
  for (const config of configs) {
    for (const binding of config.durable_objects?.bindings ?? []) {
      if (binding.script_name === undefined) unused.delete(binding.class_name)
    }
  }
  return unused
}

export function prunePluginBindings(source, disabled, retained = []) {
  if (!disabled.length) return source
  const environments = Object.keys(staticValue(source).env ?? {})
  const scopes = [[], ...environments.map((name) => ['env', name])]
  let result = source
  for (const [kind, fields] of Object.entries(wranglerBindings)) {
    const names = new Set(
      disabled.filter((binding) => binding.kind === kind).map(({ name }) => name),
    )
    if (!names.size) continue
    const nameKey = kind === 'rate_limit' || kind === 'durable_object' ? 'name' : 'binding'
    for (const scope of scopes) {
      result = dropBindingKind(result, scope, fields, names, nameKey)
    }
  }
  const classes = new Set(
    disabled
      .filter(({ kind, className }) => kind === 'durable_object' && className)
      .map(({ className }) => className),
  )
  for (const { kind, className } of retained) {
    if (kind === 'durable_object') classes.delete(className)
  }
  if (!classes.size) return result
  const config = staticValue(result)
  const inheritingEnvironments = Object.values(config.env ?? {}).filter(
    ({ migrations }) => !migrations,
  )
  const rootClasses = unusedClasses(classes, [config, ...inheritingEnvironments])
  result = pruneMigrations(result, [], rootClasses)
  const rootHasMigrations = Boolean(staticValue(result).migrations?.length)
  for (const name of environments) {
    const environment = config.env[name]
    if (!environment.migrations?.length) continue
    result = pruneMigrations(
      result,
      ['env', name],
      unusedClasses(classes, [environment]),
      rootHasMigrations,
    )
  }
  return result
}
