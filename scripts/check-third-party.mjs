// 第三方登记表守卫：检查 docs/third-party.md 登记表的格式，
// 并要求每个受监视的第三方 SDK 依赖都映射到登记表中的一行（规则见该文档）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REGISTRY_PATH = 'docs/third-party.md'
export const DEPS_PATH = 'scripts/third-party-deps.json'
export const COLUMNS = [
  '第三方',
  '我们自动查询',
  '教使用者做的事',
  '代码 / 文档位置',
  '官方出处',
  '上次核对',
  '验证方式',
]
export const VERIFICATION_METHODS = ['真账号', '文档', '模拟', '未核对']
const TABLE_HEADING = '## 登记表'
// 与 pnpm-workspace.yaml 的 packages 一致；根目录 package.json 另行检查
const WORKSPACE_DIRS = ['apps', 'packages', 'plugins']

function splitRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  // 单元格内的 `\|` 是转义竖线，不作为分隔符
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
}

/** 解析「登记表」小节的第一张表，返回行号与单元格。 */
export function parseRegistry(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === TABLE_HEADING)
  if (start === -1) return { problems: [`缺少「${TABLE_HEADING}」小节`], rows: [] }
  let index = start + 1
  while (index < lines.length && !lines[index].trim().startsWith('|')) {
    if (lines[index].startsWith('## ')) break
    index++
  }
  const header = splitRow(lines[index] ?? '')
  if (!header) return { problems: [`「${TABLE_HEADING}」小节没有表格`], rows: [] }
  const problems = []
  if (header.join('|') !== COLUMNS.join('|'))
    problems.push(`表头应为「${COLUMNS.join(' | ')}」，实际为「${header.join(' | ')}」`)
  const rows = []
  for (let i = index + 2; i < lines.length; i++) {
    const cells = splitRow(lines[i])
    if (!cells) break
    rows.push({ line: i + 1, cells })
  }
  if (rows.length === 0) problems.push('登记表没有数据行')
  return { problems, rows }
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function checkSource(cell) {
  if (cell === '待核实') return null
  const links = [...cell.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1])
  if (links.length === 0) return '官方出处应为 https 链接或「待核实」'
  const bad = links.filter((href) => !href.startsWith('https://'))
  if (bad.length > 0) return `官方出处必须是 https 链接：${bad.join('、')}`
  const rest = cell.replace(/\[[^\]]*\]\([^)\s]+\)/g, '').replace(/[、，,\s]/g, '')
  if (rest.length > 0) return `官方出处只能包含链接（多个用顿号分隔），多余内容：${rest}`
  return null
}

/** 检查登记表格式，返回问题列表与登记的第三方名称。 */
export function checkRegistry(markdown, file = REGISTRY_PATH) {
  const { problems: parseProblems, rows } = parseRegistry(markdown)
  const problems = parseProblems.map((message) => `${file}: ${message}`)
  const names = new Set()
  for (const { line, cells } of rows) {
    const where = `${file}:${line}`
    if (cells.length !== COLUMNS.length) {
      problems.push(`${where}: 应有 ${COLUMNS.length} 列，实际 ${cells.length} 列`)
      continue
    }
    const [name, , , , source, checkedAt, method] = cells
    cells.forEach((cell, column) => {
      if (cell === '') problems.push(`${where}: 「${COLUMNS[column]}」不能为空（没有内容写 —）`)
    })
    if (names.has(name)) problems.push(`${where}: 第三方「${name}」重复登记`)
    names.add(name)
    if (!VERIFICATION_METHODS.includes(method))
      problems.push(
        `${where}: 验证方式「${method}」不合法，只能是 ${VERIFICATION_METHODS.join(' / ')}`,
      )
    if (method === '未核对') {
      if (checkedAt !== '—')
        problems.push(`${where}: 未核对的行上次核对写 —，实际为「${checkedAt}」`)
    } else if (!isValidDate(checkedAt)) {
      problems.push(`${where}: 上次核对「${checkedAt}」应为 YYYY-MM-DD`)
    }
    const sourceProblem = checkSource(source)
    if (sourceProblem) problems.push(`${where}: ${sourceProblem}`)
  }
  return { problems, names }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 根目录与各 workspace 的 package.json（跳过 node_modules）。 */
export function workspaceManifests(root) {
  const manifests = [join(root, 'package.json')]
  for (const dir of WORKSPACE_DIRS) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifest = join(base, entry.name, 'package.json')
      if (entry.isDirectory() && existsSync(manifest)) manifests.push(manifest)
    }
  }
  return manifests.filter((path) => existsSync(path))
}

/** 检查受监视的依赖都映射到登记行。 */
export function checkDependencies({ root, config, names }) {
  const problems = []
  const watch = config.watch.map((pattern) => new RegExp(pattern))
  const mapped = config.packages ?? {}
  const ignored = config.ignore ?? {}
  for (const [pkg, row] of Object.entries(mapped)) {
    if (!names.has(row))
      problems.push(`${DEPS_PATH}: ${pkg} 映射到「${row}」，但 ${REGISTRY_PATH} 没有这一行`)
  }
  for (const [pkg, reason] of Object.entries(ignored)) {
    if (typeof reason !== 'string' || reason.trim() === '')
      problems.push(`${DEPS_PATH}: ignore 中的 ${pkg} 必须写明原因`)
  }
  for (const manifestPath of workspaceManifests(root)) {
    const manifest = readJson(manifestPath)
    const deps = new Set(
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
        (field) => Object.keys(manifest[field] ?? {}),
      ),
    )
    for (const dep of deps) {
      if (!watch.some((pattern) => pattern.test(dep))) continue
      if (dep in mapped || dep in ignored) continue
      problems.push(
        `${relative(root, manifestPath)}: ${dep} 是受监视的第三方 SDK，` +
          `请先在 ${REGISTRY_PATH} 登记对应第三方，再在 ${DEPS_PATH} 的 packages 中映射到该行` +
          '（不连接第三方服务的依赖放入 ignore 并写原因）',
      )
    }
  }
  return problems
}

export function checkThirdParty(root) {
  const { problems, names } = checkRegistry(readFileSync(join(root, REGISTRY_PATH), 'utf8'))
  return [
    ...problems,
    ...checkDependencies({ root, config: readJson(join(root, DEPS_PATH)), names }),
  ]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../..')
  const problems = checkThirdParty(root)
  if (problems.length > 0) {
    console.error(`第三方登记检查失败（${problems.length} 项）：`)
    for (const problem of problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log('第三方登记检查通过')
}
