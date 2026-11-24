#!/usr/bin/env node
// 依赖规则见 docs/02-project-structure.md；manifest 与源码均检查。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'

const ROOT = resolve(import.meta.dirname, '..')
const REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  'react-email',
])
const REACT_SCOPES = ['@react-email/']
const PLUGIN_CLOUDFLARE_PACKAGES = new Set([
  'agents',
  '@cloudflare/ai-chat',
  '@cloudflare/workers-types',
  '@sentry/cloudflare',
])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const BUILD_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.wrangler',
  '.output',
  '.turbo',
  '.git',
])

function readWorkspace(root, dir) {
  const base = join(root, dir)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map((name) => join(base, name))
    .filter((path) => existsSync(join(path, 'package.json')))
    .map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')),
    }))
}

export function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return BUILD_DIRS.has(name) ? [] : sourceFiles(path)
    return /\.(m|c)?[jt]sx?$/.test(name) ? [path] : []
  })
}

function staticString(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
    return node.text
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left)
    const right = staticString(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

// AST 忽略注释/普通字符串，保留 type import，且支持空白、转义和 import() 第二参数。
function importsOfSource(source) {
  const imports = []
  function visit(node) {
    let specifierNode
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifierNode = node.moduleSpecifier
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifierNode = node.moduleReference.expression
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifierNode = node.argument.literal
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifierNode = node.arguments[0]
    }
    const specifier = staticString(specifierNode)
    if (specifier !== null) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      imports.push({ specifier, line: line + 1 })
    }
    node.forEachChild(visit)
  }
  visit(source)
  return imports
}

function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function matchesDependency(dep, pattern) {
  return pattern.endsWith('/*') ? dep.startsWith(pattern.slice(0, -1)) : dep === pattern
}

// TS 7 使用 native parser API；虚拟项目只解析传入源码，不加载库或解析依赖。
function parseSources(files, read) {
  const config = '/check-deps/tsconfig.json'
  const virtual = {
    [config]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, allowJs: true },
      files: Object.keys(files),
    }),
    ...files,
  }
  const api = new API({ cwd: '/check-deps', fs: createVirtualFileSystem(virtual) })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const program = snapshot.getProject(config).program
      return new Map(
        Object.keys(files).map((file) => [file, read(program.getSourceFile(file), file)]),
      )
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}

export function importsOf(text, file = 'source.ts') {
  const path = resolve('/check-deps', file)
  return parseSources({ [path]: text }, importsOfSource).get(path)
}

function unwrapExpression(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node))
  ) {
    node = node.expression
  }
  return node
}

// 生成器执行清单；依赖检查只读静态字段，以便在安装依赖前检查生成的项目。
function pluginBoundaries(source, dir) {
  const bindings = new Map()
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        bindings.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  const unreadable = new Set()
  function value(node, seen = new Set()) {
    node = unwrapExpression(node)
    if (node && ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text)
      return value(bindings.get(node.text), seen)
    }
    return node
  }

  function property(node, key, field = key, seen = new Set()) {
    if (!node) return undefined
    if (!ts.isObjectLiteralExpression(node) || seen.has(node)) {
      unreadable.add(field)
      return undefined
    }
    const ancestors = new Set(seen).add(node)
    for (const member of [...node.properties].reverse()) {
      if (ts.isSpreadAssignment(member)) {
        const spreadValue = property(value(member.expression), key, field, ancestors)
        if (spreadValue) return spreadValue
        continue
      }
      const name = member.name
      const keyText = ts.isComputedPropertyName(name)
        ? staticString(value(name.expression))
        : name.text
      if (keyText === null) unreadable.add(field)
      if (keyText !== key) continue
      if (ts.isPropertyAssignment(member)) return value(member.initializer)
      if (ts.isShorthandPropertyAssignment(member)) return value(name)
      unreadable.add(field)
      return undefined
    }
  }

  const declaration = source.statements.find(
    (node) => ts.isExportAssignment(node) && !node.isExportEquals,
  )
  let manifest = value(declaration?.expression)
  if (manifest && ts.isCallExpression(manifest)) {
    const callee = manifest.expression
    if (ts.isIdentifier(callee) && callee.text === 'definePlugin') {
      manifest = value(manifest.arguments[0])
    }
  }
  if (!manifest || !ts.isObjectLiteralExpression(manifest)) {
    return { requires: new Set(), unreadable: new Set(['default export']) }
  }
  const dependencies = property(property(manifest, 'requires'), 'plugins', 'requires.plugins')
  const requires = new Set()
  if (dependencies) {
    if (!ts.isArrayLiteralExpression(dependencies)) unreadable.add('requires.plugins')
    else {
      for (const element of dependencies.elements) {
        const plugin = staticString(value(element))
        if (plugin === null) unreadable.add('requires.plugins')
        else requires.add(plugin)
      }
    }
  }
  const entries = property(manifest, 'entries')
  const entry = (object, key, field) => {
    const node = property(object, key, field)
    if (!node) return undefined
    const file = staticString(node)
    if (file === null) unreadable.add(field)
    else return resolve(dir, file)
  }
  return {
    requires,
    unreadable,
    routes: entry(property(manifest, 'routes'), 'dir', 'routes.dir'),
    web: entry(entries, 'web', 'entries.web'),
    worker: entry(entries, 'worker', 'entries.worker'),
    jobs: entry(entries, 'jobs', 'entries.jobs'),
    webNode: entry(entries, 'webNode', 'entries.webNode'),
    jobsNode: entry(entries, 'jobsNode', 'entries.jobsNode'),
  }
}

function isInside(path, dir) {
  return path.startsWith(dir + sep)
}

function pathImport(file, specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return resolve(dirname(file), specifier.split(/[?#]/, 1)[0])
  }
}

function exportedPaths(value) {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportedPaths)
  return []
}

function pluginEntryPaths(manifest, subpath) {
  const exports = manifest.exports
  if (exports === undefined) return [subpath || manifest.main || 'index.js']
  const key = subpath ? `./${subpath}` : '.'
  if (exports && Object.hasOwn(exports, key)) return exportedPaths(exports[key])
  if (exports && typeof exports === 'object') {
    for (const [pattern, value] of Object.entries(exports)) {
      if (!pattern.startsWith('./') || !pattern.includes('*')) continue
      const [prefix, suffix] = pattern.split('*')
      if (
        key.startsWith(prefix) &&
        key.endsWith(suffix) &&
        key.length >= prefix.length + suffix.length
      ) {
        const match = key.slice(prefix.length, key.length - suffix.length)
        return exportedPaths(value).map((path) => path.replaceAll('*', match))
      }
    }
    if (Object.keys(exports).some((key) => key.startsWith('.'))) return []
  }
  return subpath ? [] : exportedPaths(exports)
}

function resolvePluginSource(path, pluginSources) {
  if (pluginSources.has(path)) return path
  const stem = path.replace(/\.[cm]?jsx?$/, '')
  for (const extension of SOURCE_EXTENSIONS) {
    if (pluginSources.has(stem + extension)) return stem + extension
    const index = join(path, `index${extension}`)
    if (pluginSources.has(index)) return index
  }
}

function reachablePluginFiles(entries, parsed, pluginSources, pluginNames) {
  const reachable = new Set()
  const pending = entries.filter((file) => pluginSources.has(file))
  while (pending.length) {
    const file = pending.pop()
    if (reachable.has(file)) continue
    reachable.add(file)
    for (const { specifier } of parsed.get(file).imports) {
      const dep = packageNameOf(specifier)
      const plugin = pluginNames.get(dep)
      const target = pathImport(file, specifier)
      const paths = target ? [target] : []
      if (plugin) {
        for (const path of pluginEntryPaths(plugin.manifest, specifier.slice(dep.length + 1))) {
          paths.push(resolve(plugin.path, path))
        }
      }
      for (const path of paths) {
        const imported = resolvePluginSource(path, pluginSources)
        if (imported) pending.push(imported)
      }
    }
  }
  return reachable
}

function pluginCloudflareEntry(file, dir, plugin) {
  if (isInside(file, join(dir, 'src/node'))) return false
  return (
    file === plugin?.worker ||
    file === plugin?.jobs ||
    isInside(file, join(dir, 'src/worker')) ||
    isInside(file, join(dir, 'src/jobs'))
  )
}

export function cloudflareAllowed(file, specifier, rules) {
  if (
    file.startsWith('packages/platform/src/cloudflare/') &&
    ['cloudflare:workers', 'cloudflare:workflows'].includes(specifier)
  )
    return true
  if (specifier === 'cloudflare:workers') {
    if (rules.compositionEntries.includes(file)) return true
  }
  return rules.targetFixtures[file]?.includes(specifier) === true
}

function platformTargetOf(root, file, specifier, platformPackage) {
  const named = specifier.startsWith(`${platformPackage}/`)
    ? specifier.slice(platformPackage.length + 1).split('/')[0]
    : null
  if (named === 'cloudflare' || named === 'node') return named
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null
  const target = relative(root, resolve(join(file, '..'), specifier))
    .split(sep)
    .join('/')
  return (
    /^packages\/platform\/src\/(cloudflare|node)(?:\/|(?:\.[cm]?[jt]sx?)?$)/.exec(target)?.[1] ??
    null
  )
}

function platformTargetAllowed(file, target, rules) {
  if (file.startsWith(`packages/platform/src/${target}/`)) return true
  const entries =
    target === 'cloudflare' ? rules.compositionEntries : (rules.nodeCompositionEntries ?? [])
  if (entries.includes(file)) return true
  if (rules.targetAdapterFixtures?.[file]?.includes(target)) return true
  return (
    target === 'cloudflare' &&
    rules.targetFixtures[file]?.some((specifier) => specifier.startsWith('cloudflare:')) === true
  )
}

export function checkWorkspace(
  root = ROOT,
  rules = JSON.parse(readFileSync(join(ROOT, 'scripts/check-deps.rules.json'), 'utf8')),
) {
  const apps = readWorkspace(root, 'apps')
  const packages = readWorkspace(root, 'packages')
  const plugins = readWorkspace(root, 'plugins')
  const pluginRoot = join(root, 'plugins')
  const webPath = join(root, 'apps/web')
  const webPackage = apps.find(({ path }) => path === webPath)?.manifest.name
  const uiManifest = join(root, 'packages/ui/package.json')
  const uiPackage = JSON.parse(readFileSync(uiManifest, 'utf8')).name
  const scope = /^(@[^/]+\/)ui$/.exec(uiPackage)?.[1]
  if (!scope) throw new Error(`${uiManifest}：name 必须为 @scope/ui，无法确定内部包 scope`)
  const emailPackage = `${scope}email`
  const platformPackage = `${scope}platform`
  // 评测工具只供根目录命令行使用，不得进入任何应用或运行时包（含其测试与脚本）。
  const evalsPackage = `${scope}evals`
  const layers = {
    [`${scope}shared`]: [],
    [`${scope}config`]: [`${scope}shared`],
    [`${scope}db`]: [`${scope}shared`, `${scope}config`],
    [platformPackage]: [`${scope}shared`, `${scope}config`, `${scope}db`],
  }
  const appNames = new Set(apps.map((a) => a.manifest.name))
  const packagePaths = new Set(packages.map((pkg) => pkg.path))
  const pluginNames = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]))
  const pluginManifestPaths = new Map(plugins.map(({ path }) => [join(path, 'plugin.ts'), path]))
  const violations = []

  function pluginIdOf(dep, target) {
    const plugin = pluginNames.get(dep)
    if (plugin) return relative(pluginRoot, plugin.path)
    const prefix = `${scope}plugin-`
    if (dep?.startsWith(prefix)) return dep.slice(prefix.length)
    if (target && isInside(target, pluginRoot)) return relative(pluginRoot, target).split(sep)[0]
  }

  function checkPluginDependency(id, required, where, specifier, plugin, generated = false) {
    if (!required || generated || id === required) return
    if (!id) {
      violations.push(`${where} → ${specifier}：核心只可通过 *.gen.ts 导入插件`)
    } else if (!plugin?.requires.has(required)) {
      violations.push(`${where} → ${specifier}：插件 ${id} 须在 requires.plugins 声明 ${required}`)
    }
  }

  function checkUiDependency(pkgName, dep, where) {
    if (rules.forbiddenDependencies?.some((pattern) => matchesDependency(dep, pattern))) {
      violations.push(`${pkgName} → ${dep}（${where}）：禁止拆分 Radix 子包，请改用 radix-ui`)
    } else if (
      pkgName !== uiPackage &&
      rules.uiOnlyDependencies?.some((pattern) => matchesDependency(dep, pattern))
    ) {
      violations.push(`${pkgName} → ${dep}（${where}）：UI 底层依赖仅允许 ${uiPackage} 使用`)
    }
  }

  function checkEvalsDependency(pkgName, dep, where) {
    if (dep === evalsPackage && pkgName !== evalsPackage)
      violations.push(`${pkgName} → ${dep}（${where}）：${evalsPackage} 只允许根目录依赖`)
  }

  function checkDependency(pkgName, dep, where) {
    if (appNames.has(dep)) {
      violations.push(`${pkgName} → ${dep}（${where}）：packages 不得依赖 apps`)
    }
    const isReact =
      dep === uiPackage ||
      REACT_PACKAGES.has(dep) ||
      REACT_SCOPES.some((scope) => dep.startsWith(scope))
    if (isReact && pkgName !== uiPackage && !(pkgName === emailPackage && dep !== uiPackage)) {
      violations.push(
        `${pkgName} → ${dep}（${where}）：React 仅允许 ui，email 仅允许 React / React Email，不能依赖 ui`,
      )
    }
    const allowed = layers[pkgName]
    if (allowed && dep.startsWith(scope) && dep !== pkgName && !allowed.includes(dep)) {
      const rule = allowed.length > 0 ? `只允许依赖 ${allowed.join('、')}` : '不得依赖其他内部包'
      violations.push(`${pkgName} → ${dep}（${where}）：${pkgName} ${rule}`)
    }
  }

  // 根 manifest 同样不能成为 UI 原语的旁路依赖来源。
  const rootManifest = join(root, 'package.json')
  if (existsSync(rootManifest)) {
    const manifest = JSON.parse(readFileSync(rootManifest, 'utf8'))
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        checkUiDependency(manifest.name, dep, `package.json ${field}`)
      }
    }
  }
  const workspaces = [...packages, ...apps, ...plugins].map((workspace) => ({
    ...workspace,
    files: sourceFiles(workspace.path),
  }))
  const scriptFiles = sourceFiles(join(root, 'scripts'))
  const files = Object.fromEntries(
    [...workspaces.flatMap(({ files }) => files), ...scriptFiles].map((file) => [
      file,
      readFileSync(file, 'utf8'),
    ]),
  )
  const parsed = parseSources(files, (source, file) => ({
    imports: importsOfSource(source),
    ...(pluginManifestPaths.has(file)
      ? { plugin: pluginBoundaries(source, pluginManifestPaths.get(file)) }
      : {}),
  }))
  const pluginWorkspaces = workspaces.filter(({ path }) => isInside(path, pluginRoot))
  const pluginSources = new Set(pluginWorkspaces.flatMap(({ files }) => files))
  const webEntries = []
  const jobsEntries = []
  const nodeEntries = []
  for (const { path, files } of pluginWorkspaces) {
    const plugin = parsed.get(join(path, 'plugin.ts'))?.plugin
    const routes = plugin?.routes ?? join(path, 'routes')
    if (plugin?.unreadable.size) {
      const manifest = relative(root, join(path, 'plugin.ts')).split(sep).join('/')
      violations.push(`${manifest}：无法静态读取 ${[...plugin.unreadable].join('、')}`)
    }
    webEntries.push(
      plugin?.web,
      plugin?.worker,
      plugin?.webNode,
      ...files.filter((file) => isInside(file, routes) || isInside(file, join(path, 'src/web'))),
    )
    jobsEntries.push(plugin?.jobs, plugin?.jobsNode)
    nodeEntries.push(plugin?.webNode, plugin?.jobsNode)
  }
  const webFiles = reachablePluginFiles(webEntries, parsed, pluginSources, pluginNames)
  const jobsFiles = reachablePluginFiles(jobsEntries, parsed, pluginSources, pluginNames)
  const nodeFiles = reachablePluginFiles(nodeEntries, parsed, pluginSources, pluginNames)
  for (const file of scriptFiles) {
    if (file.endsWith('.gen.ts')) continue
    const rel = relative(root, file).split(sep).join('/')
    for (const { specifier, line } of parsed.get(file).imports) {
      const required = pluginIdOf(packageNameOf(specifier), pathImport(file, specifier))
      checkPluginDependency(undefined, required, `${rel}:${line}`, specifier)
    }
  }
  for (const { path, manifest, files } of workspaces) {
    const isPackage = packagePaths.has(path)
    const isPlugin = isInside(path, pluginRoot)
    const id = isPlugin ? relative(pluginRoot, path) : undefined
    const plugin = isPlugin ? parsed.get(join(path, 'plugin.ts'))?.plugin : undefined
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        const where = `${relative(root, join(path, 'package.json')).split(sep).join('/')} ${field}`
        checkUiDependency(manifest.name, dep, where)
        checkEvalsDependency(manifest.name, dep, where)
        // 应用声明 workspace 依赖以安装插件，但源码只通过生成入口接入。
        if (isPlugin || isPackage) checkPluginDependency(id, pluginIdOf(dep), where, dep, plugin)
        if (isPackage) checkDependency(manifest.name, dep, where)
      }
    }
    for (const file of files) {
      const rel = relative(root, file).split(sep).join('/')
      const cloudflareEntry =
        isPlugin && !nodeFiles.has(file) && pluginCloudflareEntry(file, path, plugin)
      for (const { specifier, line } of parsed.get(file).imports) {
        const where = `${rel}:${line}`
        const dep = packageNameOf(specifier)
        const target = pathImport(file, specifier)
        const corePluginImportAllowed =
          !isPlugin &&
          (file.endsWith('.gen.ts') || /^apps\/(web\/(test|e2e)|jobs\/test)\//.test(rel))
        checkPluginDependency(
          id,
          pluginIdOf(dep, target),
          where,
          specifier,
          plugin,
          corePluginImportAllowed,
        )
        if (
          isPlugin &&
          specifier.startsWith('@web/') &&
          (!webFiles.has(file) || jobsFiles.has(file))
        ) {
          violations.push(
            `${where} → ${specifier}：@web/* 仅允许插件 web 构建入口使用，jobs 及其依赖不可使用`,
          )
        }
        if (
          isPlugin &&
          ((dep && dep === webPackage) ||
            (target && (target === webPath || isInside(target, webPath))))
        ) {
          violations.push(`${where} → ${specifier}：插件的 web 入口须通过 @web/* 导入 web 核心模块`)
        }
        // UI 原语检查覆盖所有源码，不能被生产 src 或目标夹具豁免。
        if (dep) checkUiDependency(manifest.name, dep, where)
        if (dep) checkEvalsDependency(manifest.name, dep, where)
        else if (target && manifest.name !== evalsPackage) {
          const evals = packages.find((pkg) => pkg.manifest.name === evalsPackage)
          if (evals && (target === evals.path || isInside(target, evals.path)))
            checkEvalsDependency(manifest.name, evalsPackage, where)
        }
        if (
          isPlugin &&
          specifier !== 'cloudflare:test' &&
          (specifier.startsWith('cloudflare:') || PLUGIN_CLOUDFLARE_PACKAGES.has(dep))
        ) {
          if (!cloudflareEntry)
            violations.push(
              `${where} → ${specifier}：Cloudflare 专用导入仅允许插件 worker / jobs 入口`,
            )
          continue
        }
        if (specifier.startsWith('cloudflare:')) {
          if (cloudflareAllowed(rel, specifier, rules)) continue
          violations.push(
            `${where} → ${specifier}：仅允许平台 Cloudflare 适配器、显式 composition entry 与目标测试夹具`,
          )
          continue
        }
        const platformTarget = platformTargetOf(root, file, specifier, platformPackage)
        const pluginAdapterEntry =
          platformTarget === 'cloudflare'
            ? cloudflareEntry
            : isPlugin && (file === plugin?.webNode || file === plugin?.jobsNode)
        if (
          platformTarget &&
          !pluginAdapterEntry &&
          !platformTargetAllowed(rel, platformTarget, rules)
        ) {
          violations.push(
            `${where} → ${specifier}：业务仅可依赖 platform 中立入口；${platformTarget} 适配器仅允许对应目标目录、显式 composition entry 与目标测试夹具`,
          )
        }
        // 既有包依赖规则只约束生产 src；测试的 React/应用夹具不属于业务依赖。
        if (!isPackage || !file.startsWith(join(path, 'src') + sep)) continue
        if (specifier.startsWith('.')) {
          const target = resolve(join(file, '..'), specifier)
          if (target.startsWith(join(root, 'apps') + sep)) {
            violations.push(
              `${manifest.name} → ${specifier}（${where}）：packages 不得引用 apps 下的文件`,
            )
          } else {
            const targetPackage = packages.find(
              (pkg) => target === pkg.path || target.startsWith(pkg.path + sep),
            )
            if (targetPackage && targetPackage.path !== path) {
              checkDependency(manifest.name, targetPackage.manifest.name, where)
            }
          }
          continue
        }
        if (dep) checkDependency(manifest.name, dep, where)
      }
    }
  }
  return { violations, packages: packages.length, apps: apps.length, plugins: plugins.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkWorkspace()
  if (result.violations.length > 0) {
    console.error(`依赖方向检查失败（${result.violations.length} 处）：`)
    for (const violation of result.violations) console.error(`  - ${violation}`)
    process.exitCode = 1
  } else {
    console.log(
      `依赖方向检查通过：${result.packages} 个包，${result.apps} 个应用，${result.plugins} 个插件`,
    )
  }
}
