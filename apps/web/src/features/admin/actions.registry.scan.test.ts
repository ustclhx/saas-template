import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adminActions } from './actions.registry.ts'

// add-admin-step-up tasks.md 1.4：静态扫描后台写包装的调用点，与动作登记表双向一致——
// 每个调用点的动作名都已登记，每个登记键至少有一个调用点（防止改名后漂移）。
// 仓库的 TypeScript 7 不提供 JS 解析 API，这里用只认字符串、注释与括号的轻量扫描。

const ROOT = join(import.meta.dirname, '../../../../..')
const SCAN_DIRS = [
  'apps/web/src',
  ...readdirSync(join(ROOT, 'plugins')).map((plugin) => `plugins/${plugin}/src`),
]

/** 包装名 → 动作名参数的位置 */
const WRAPPERS: Record<string, number> = {
  adminAction: 0,
  withAdminAction: 1,
  runAdminAction: 1,
  withDelegatedAdminAction: 1,
  runDelegatedAdminAction: 1,
}
/** 包装自身的实现文件：其中的调用转发调用方传入的动作名 */
const WRAPPER_FILES = new Set([
  'apps/web/src/features/admin/action.ts',
  'apps/web/src/features/admin/action.server.ts',
])
/**
 * 动作名无法从调用点或同文件 `const` 初始化表达式读出的调用点。其动作名由登记来源给出：
 * 工具定义的 `adminAction: (...) => ({ name: '…' })`，以及
 * `satisfies Record<…, …AdminActionName>` 的映射表。
 */
const DYNAMIC_CALL_SITES = new Set(['apps/web/src/features/admin/impersonation.server.ts'])
/** 已登记、入口由后续任务实现（add-admin-step-up 第 3 组：确认页 Server Function） */
const RESERVED_WITHOUT_CALL_SITE = new Set([
  'admin.confirmation.confirm',
  'admin.confirmation.reject',
])

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir)
  try {
    statSync(absolute)
  } catch {
    return []
  }
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => !file.split(sep).includes('paraglide') && !file.endsWith('.gen.ts'))
    .map((file) => relative(ROOT, join(absolute, file)).split(sep).join('/'))
}

/** 匹配位置所在行是否为注释（行注释或块注释续行） */
function inComment(source: string, index: number): boolean {
  const line = source.slice(source.lastIndexOf('\n', index) + 1, index)
  return /^\s*(\*|\/\*|\/\/)/.test(line) || line.includes('//')
}

/** 返回字符串字面量结束后的下标；模板字符串中的 `${}` 按括号深度跳过 */
function skipString(source: string, start: number): number {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') i += 2
    else if (char === quote) return i + 1
    else if (quote === '`' && char === '$' && source[i + 1] === '{') i = skipBalanced(source, i + 1)
    else i++
  }
  return i
}

/** 从开括号开始，返回配对闭括号之后的下标 */
function skipBalanced(source: string, open: number): number {
  let depth = 0
  let i = open
  while (i < source.length) {
    const char = source[i] as string
    if (char === "'" || char === '"' || char === '`') {
      i = skipString(source, i)
      continue
    }
    if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

/** 按顶层逗号拆分括号内的内容 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < body.length) {
    const char = body[i] as string
    if (char === "'" || char === '"' || char === '`') {
      i = skipString(body, i)
      continue
    }
    if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(body.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

const literals = (expression: string) =>
  [...expression.matchAll(/'([^'\\]+)'|"([^"\\]+)"/g)].map((match) => match[1] ?? match[2])

/** 动作引用表达式中的动作名：对象形式只看 `name` 属性 */
function actionLiterals(expression: string): string[] {
  const trimmed = expression.trim()
  if (trimmed.startsWith('{')) {
    const name = splitTopLevel(trimmed.slice(1, -1)).find((part) => /^name\s*:/.test(part))
    return name ? actionLiterals(name.replace(/^name\s*:/, '')) : []
  }
  return literals(trimmed) as string[]
}

/** 参数是同文件 `const x = …` 定义的变量时，改看其初始化表达式 */
function resolveConst(source: string, expression: string): string {
  if (!/^\w+$/.test(expression.trim())) return expression
  const match = new RegExp(`\\bconst ${expression.trim()}\\s*=`).exec(source)
  if (!match) return expression
  const rest = source.slice(match.index + match[0].length)
  const end = rest.search(/\n\s*(?:const|let|await|return|if|for)\b/)
  return end === -1 ? rest : rest.slice(0, end)
}

interface CallSite {
  readonly file: string
  readonly wrapper: string
  readonly names: readonly string[]
}

function scan() {
  const calls: CallSite[] = []
  const sourced = new Set<string>()
  const pluginKeys = new Set<string>()
  for (const file of SCAN_DIRS.flatMap(sourceFiles)) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const wrapperCall = new RegExp(`(?<![.\\w])(${Object.keys(WRAPPERS).join('|')})\\s*\\(`, 'g')
    for (const match of source.matchAll(wrapperCall)) {
      const wrapper = match[1] as string
      const index = match.index ?? 0
      if (WRAPPER_FILES.has(file) || inComment(source, index)) continue
      // 函数声明与方法签名不是调用
      if (/function\s*$/.test(source.slice(Math.max(0, index - 9), index))) continue
      const open = index + match[0].length - 1
      const close = skipBalanced(source, open)
      if (/^\s*:/.test(source.slice(close, close + 10))) continue
      const args = splitTopLevel(source.slice(open + 1, close - 1))
      const expression = args[WRAPPERS[wrapper] as number] ?? ''
      calls.push({ file, wrapper, names: actionLiterals(resolveConst(source, expression)) })
    }
    // 工具定义：adminAction: (input) => ({ name: '…', input })
    for (const match of source.matchAll(/\badminAction\s*:/g)) {
      const rest = source.slice((match.index ?? 0) + match[0].length)
      const end = splitTopLevel(`${rest}`)[0] ?? ''
      for (const name of end.matchAll(/name\s*:\s*'([^']+)'/g)) sourced.add(name[1] as string)
    }
    // 映射表：{ … } as const satisfies Record<…, …AdminActionName>
    for (const match of source.matchAll(
      /=\s*(\{[^{}]*\})\s*as const satisfies Record<[^>]*AdminActionName>/g,
    ))
      for (const part of splitTopLevel((match[1] as string).slice(1, -1)))
        for (const name of literals(part.slice(part.lastIndexOf(':') + 1)))
          sourced.add(name as string)
    // 插件登记：defineAdminActions('owner', { 'key': … })
    for (const match of source.matchAll(/\bdefineAdminActions\s*\(/g)) {
      if (file.endsWith('actions.registry.ts')) continue
      const open = (match.index ?? 0) + match[0].length - 1
      const [, group = ''] = splitTopLevel(source.slice(open + 1, skipBalanced(source, open) - 1))
      for (const entry of splitTopLevel(group.trim().slice(1, -1)))
        pluginKeys.add(literals(entry.slice(0, entry.indexOf(':')))[0] as string)
    }
  }
  return { calls, sourced, pluginKeys }
}

describe('后台动作调用点与登记表双向一致', () => {
  const { calls, sourced, pluginKeys } = scan()
  const registered = new Set([...Object.keys(adminActions), ...pluginKeys])

  it('扫描到全部包装调用与插件登记', () => {
    expect(calls.length).toBeGreaterThan(20)
    expect(pluginKeys).toContain('admin.api_token.create')
  })

  it('每个调用点都使用已登记的动作名，动作名来自表达式的调用点均已列明', () => {
    const dynamic = calls.filter((call) => call.names.length === 0)
    expect(dynamic.map((call) => call.file).sort()).toEqual([...DYNAMIC_CALL_SITES].sort())
    const used = [...calls.flatMap((call) => call.names), ...sourced]
    expect(used.filter((name) => !registered.has(name))).toEqual([])
  })

  it('每个登记键至少有一个调用点', () => {
    const used = new Set([...calls.flatMap((call) => call.names), ...sourced])
    const unused = [...registered].filter((name) => !used.has(name))
    expect(unused.sort()).toEqual([...RESERVED_WITHOUT_CALL_SITE].sort())
  })
})
