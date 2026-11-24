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

function dropMembers(source, collection, removed) {
  const edits = []
  const { members } = collection
  for (let index = 0; index < members.length; index++) {
    if (!removed.has(members[index])) continue
    const first = index
    while (removed.has(members[index + 1])) index++
    const last = members[index]
    const before = members[first - 1]
    edits.push({
      start: last.comma === undefined && before ? before.comma : members[first].start,
      end: last.comma === undefined ? last.end : last.comma + 1,
    })
  }
  return edits
    .reverse()
    .reduce((text, { start, end }) => text.slice(0, start) + text.slice(end), source)
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
    if (removed.size < collection.members.length) return dropMembers(source, collection, removed)
  } else if (!names.has(bindingName(field))) return source

  // 整段只含停用绑定时可删除字段；共享的 queues 等容器保留其他配置。
  let index = parents.length - 1
  while (index > scopePath.length && parents[index].collection.members.length === 1) index--
  return dropMembers(source, parents[index].collection, new Set([parents[index].field]))
}

export function prunePluginBindings(source, disabled) {
  let result = source
  for (const [kind, fields] of Object.entries(wranglerBindings)) {
    const names = new Set(
      disabled.filter((binding) => binding.kind === kind).map(({ name }) => name),
    )
    if (!names.size) continue
    const nameKey = kind === 'rate_limit' || kind === 'durable_object' ? 'name' : 'binding'
    for (const scope of [[], ['env', 'staging'], ['env', 'production']]) {
      result = dropBindingKind(result, scope, fields, names, nameKey)
    }
  }
  return result
}
