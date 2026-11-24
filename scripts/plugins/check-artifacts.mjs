// 构建产物剔除检查（openspec add-plugin-system 1.2，供 5.4 复用）：在 web（Cloudflare dist、Node .output）
// 与 jobs（Cloudflare dist、Node .output）的构建产物中搜索插件特有字符串。
//
//   node scripts/plugins/check-artifacts.mjs --absent AiMediaWorkflow fal.media   # 关闭插件后：一处都不能有
//   node scripts/plugins/check-artifacts.mjs --present PLUGIN_EXAMPLE_            # 启用插件后：每个产物都要有
//
// 含 source map（sourcesContent 会带入源码），不存在的产物目录跳过并提示；--only web,jobs-node 只查部分产物。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname
export const ARTIFACTS = {
  web: 'apps/web/dist',
  'web-node': 'apps/web/.output',
  jobs: 'apps/jobs/dist',
  'jobs-node': 'apps/jobs/.output',
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Node 产物里的依赖目录不是我们的代码，且体积大
      if (entry.name === 'node_modules') continue
      yield* files(path)
    } else if (entry.isFile() && statSync(path).size < 50 * 1024 * 1024) yield path
  }
}

/** 每个产物中命中各字符串的文件（相对仓库根） */
export function scanArtifacts(needles, { root = ROOT, only = Object.keys(ARTIFACTS) } = {}) {
  const result = {}
  for (const name of only) {
    const dir = join(root, ARTIFACTS[name])
    if (!existsSync(dir)) {
      result[name] = null
      continue
    }
    const hits = Object.fromEntries(needles.map((needle) => [needle, []]))
    for (const path of files(dir)) {
      const text = readFileSync(path, 'latin1')
      for (const needle of needles)
        if (text.includes(needle)) hits[needle].push(relative(root, path))
    }
    result[name] = hits
  }
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const mode = args[0]
  const onlyIndex = args.indexOf('--only')
  const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1]?.split(',')
  const needles = args
    .slice(1)
    .filter((_, i, list) => i !== list.indexOf('--only') && list[i - 1] !== '--only')
  if (!['--absent', '--present'].includes(mode ?? '') || needles.length === 0) {
    console.error(
      '用法：check-artifacts.mjs --absent|--present <字符串...> [--only web,web-node,jobs,jobs-node]',
    )
    process.exit(2)
  }
  let failed = false
  for (const [name, hits] of Object.entries(scanArtifacts(needles, only ? { only } : {}))) {
    if (hits === null) {
      console.log(`- ${name}: 产物目录 ${ARTIFACTS[name]} 不存在，跳过`)
      continue
    }
    for (const [needle, paths] of Object.entries(hits)) {
      const ok = mode === '--absent' ? paths.length === 0 : paths.length > 0
      failed ||= !ok
      console.log(
        `${ok ? '✓' : '✗'} ${name}: ${needle} 命中 ${paths.length} 个文件${paths.length ? `（${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ' …' : ''}）` : ''}`,
      )
    }
  }
  process.exit(failed ? 1 : 0)
}
