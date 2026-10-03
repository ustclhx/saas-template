#!/usr/bin/env node
// 依赖方向检查（docs/02-project-structure.md「依赖方向」）：
//   1. packages/* 不得依赖 apps/*
//   2. 除 @saas/ui 外的包不得依赖 React（含 @saas/ui 本身）
//   3. 基础包分层：shared 不依赖其他内部包；config 只依赖 shared；db 只依赖 shared、config
// 同时检查 package.json 中声明的依赖与 src 中实际的 import，任一违规即以非零码退出。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const SCOPE = '@saas/'
const UI_PACKAGE = '@saas/ui'
const REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  UI_PACKAGE,
])
const LAYERS = {
  '@saas/shared': [],
  '@saas/config': ['@saas/shared'],
  '@saas/db': ['@saas/shared', '@saas/config'],
}
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function readWorkspace(dir) {
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

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(m|c)?[jt]sx?$/.test(name) ? [path] : []
  })
}

// 覆盖 import / export from / 动态 import / require
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
}

function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const apps = readWorkspace('apps')
const packages = readWorkspace('packages')
const appNames = new Set(apps.map((a) => a.manifest.name))
const appDirs = apps.map((a) => a.path + sep)
const violations = []

function checkDependency(pkgName, dep, where) {
  if (appNames.has(dep)) {
    violations.push(`${pkgName} → ${dep}（${where}）：packages 不得依赖 apps`)
  }
  if (pkgName !== UI_PACKAGE && REACT_PACKAGES.has(dep)) {
    violations.push(`${pkgName} → ${dep}（${where}）：只有 ${UI_PACKAGE} 可以依赖 React`)
  }
  const allowed = LAYERS[pkgName]
  if (allowed && dep.startsWith(SCOPE) && dep !== pkgName && !allowed.includes(dep)) {
    const rule = allowed.length > 0 ? `只允许依赖 ${allowed.join('、')}` : '不得依赖其他内部包'
    violations.push(`${pkgName} → ${dep}（${where}）：${pkgName} ${rule}`)
  }
}

for (const { path, manifest } of packages) {
  const name = manifest.name
  for (const field of DEP_FIELDS) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      checkDependency(name, dep, `package.json ${field}`)
    }
  }
  for (const file of sourceFiles(join(path, 'src'))) {
    const rel = relative(root, file)
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) {
        const target = resolve(join(file, '..'), specifier)
        if (
          appDirs.some((dir) => target.startsWith(dir)) ||
          target.startsWith(join(root, 'apps') + sep)
        ) {
          violations.push(`${name} → ${specifier}（${rel}）：packages 不得引用 apps 下的文件`)
        }
        continue
      }
      const dep = packageNameOf(specifier)
      if (dep) checkDependency(name, dep, rel)
    }
  }
}

if (violations.length > 0) {
  console.error(`依赖方向检查失败（${violations.length} 处）：`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log(`依赖方向检查通过：${packages.length} 个包，${apps.length} 个应用`)
