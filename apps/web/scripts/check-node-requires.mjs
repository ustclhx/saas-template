// Node 产物运行时 require 检查：.output/server（不含 trace 出的 node_modules）中，rolldown 的
// `__require`（createRequire 运行时调用）只允许指向 Node 内置模块。
// 背景：Nitro 两遍构建中，Vite SSR service 会内联 web 根解析不到的 CJS 依赖（lucide-react 的 node 条件、
// use-sync-external-store），若其中的 require('react') 被转成 `__require`，Nitro 第二遍看不到它，
// 运行时会从仓库 node_modules 再加载一份 react，与打包进产物的 react 成为两个实例（预渲染 lucide
// useContext 为 null），独立部署时还会因产物内没有 react 而无法加载。pnpm 锁文件层面的单实例检查拦不住这类问题。
// 用法：node scripts/check-node-requires.mjs [.output/server]；`build:node` 在 bootstrap 之后自动执行。
import { readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RUNTIME_REQUIRE = /\b__require\(\s*["']([^"']+)["']\s*\)/g

/** 返回 serverDir 下所有 .mjs 中指向非内置模块的运行时 require */
export function findRuntimeRequires(serverDir) {
  const violations = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.mjs')) {
        for (const [, specifier] of readFileSync(path, 'utf8').matchAll(RUNTIME_REQUIRE)) {
          if (!isBuiltin(specifier)) violations.push({ file: relative(serverDir, path), specifier })
        }
      }
    }
  }
  walk(serverDir)
  return violations
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const serverDir = resolve(
    process.argv[2] ?? fileURLToPath(new URL('../.output/server', import.meta.url)),
  )
  const violations = findRuntimeRequires(serverDir)
  if (violations.length > 0) {
    console.error(
      'Node 产物检查失败：以下运行时 require 指向非内置模块（应由 Nitro 打包，见 vite.node.config.ts）：',
    )
    for (const { file, specifier } of violations) console.error(`  - ${file}: ${specifier}`)
    process.exit(1)
  }
  console.log('Node 产物检查通过：运行时 require 只指向 Node 内置模块')
}
