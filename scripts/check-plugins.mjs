import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginsForTarget, resolvePlugins } from '@saas/config'
import { loadPluginManifests, loadTemplateConfig, REPO_ROOT } from './plugins/plugins.mjs'
import { parseJsonc } from './production/check-wrangler-envs.mjs'

function checkManifestPaths(loaded) {
  const problems = []
  for (const { manifest, dir } of loaded) {
    const paths = [
      ...Object.entries(manifest.entries ?? {}).map(([kind, path]) => [
        `entries.${kind}`,
        path,
        'file',
      ]),
      ...(manifest.routes ? [['routes.dir', manifest.routes.dir, 'directory']] : []),
      ...(manifest.messages ? [['messages', manifest.messages, 'directory']] : []),
    ]
    for (const [field, path, kind] of paths) {
      const info = statSync(join(dir, path), { throwIfNoEntry: false })
      const location = `plugins/${manifest.id}/plugin.ts: ${field} ${path}`
      if (!info) problems.push(`${location} does not exist`)
      else if (kind === 'file' ? !info.isFile() : !info.isDirectory())
        problems.push(`${location} must be a ${kind}`)
    }
  }
  return problems
}

function wranglerBindings(env) {
  const sections = {
    ai: env.ai ? [env.ai] : [],
    durable_object: env.durable_objects?.bindings ?? [],
    hyperdrive: env.hyperdrive ?? [],
    kv: env.kv_namespaces ?? [],
    queue: env.queues?.producers ?? [],
    r2: env.r2_buckets ?? [],
    rate_limit: env.ratelimits ?? [],
    service: env.services ?? [],
    workflow: env.workflows ?? [],
  }
  return Object.entries(sections).flatMap(([kind, bindings]) =>
    bindings.map((binding) => ({
      kind,
      name: kind === 'durable_object' || kind === 'rate_limit' ? binding.name : binding.binding,
      className: binding.class_name,
    })),
  )
}

function pluginClassOwners(loaded) {
  const owners = new Map()
  for (const { manifest } of loaded) {
    for (const binding of [...(manifest.bindings?.web ?? []), ...(manifest.bindings?.jobs ?? [])]) {
      if (!binding.className) continue
      const key = `${binding.kind}:${binding.className}`
      if (!owners.has(key)) owners.set(key, new Set())
      owners.get(key).add(manifest.id)
    }
  }
  return owners
}

export async function checkPlugins(root = REPO_ROOT) {
  const [config, loaded] = await Promise.all([loadTemplateConfig(root), loadPluginManifests(root)])
  const resolved = resolvePlugins(
    config,
    loaded.map(({ manifest }) => manifest),
  )
  const { included } = pluginsForTarget(resolved, 'cloudflare')
  const enabled = new Set(included.map(({ manifest }) => manifest.id))
  const owners = pluginClassOwners(loaded)
  const problems = checkManifestPaths(loaded)

  for (const app of ['web', 'jobs']) {
    const file = `apps/${app}/wrangler.jsonc`
    const wrangler = parseJsonc(readFileSync(join(root, file), 'utf8'))
    const { staging = {}, production = {}, ...other } = wrangler.env ?? {}
    const environments = [
      ['top-level', wrangler],
      ['env.staging', staging],
      ['env.production', production],
      ...Object.entries(other).map(([name, env]) => [`env.${name}`, env]),
    ]
    for (const [environment, env] of environments) {
      const bindings = wranglerBindings(env)
      const location = `${file} ${environment}`
      for (const { manifest } of included) {
        for (const declared of manifest.bindings?.[app] ?? []) {
          const matches = bindings.filter(({ name }) => name === declared.name)
          const label = `${location}: plugin ${manifest.id} binding ${declared.name}`
          if (matches.length === 0 && !declared.optional)
            problems.push(`${label} is missing (expected ${declared.kind})`)
          for (const binding of matches) {
            if (binding.kind !== declared.kind)
              problems.push(`${label} has kind ${binding.kind}, expected ${declared.kind}`)
            else if (declared.className && binding.className !== declared.className)
              problems.push(
                `${label} references ${binding.className ?? 'no class'}, expected ${declared.className}`,
              )
          }
        }
      }
      // 跨 Worker 绑定可以改名，按实际引用的类标识所属插件。
      for (const { name, kind, className } of bindings) {
        const plugins = owners.get(`${kind}:${className}`)
        if (plugins && ![...plugins].some((id) => enabled.has(id)))
          problems.push(
            `${location}: remove ${kind} binding ${name} (${className} belongs to disabled plugin ${[...plugins].join(', ')})`,
          )
      }
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const problems = await checkPlugins()
    for (const problem of problems) console.error(problem)
    if (problems.length) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
