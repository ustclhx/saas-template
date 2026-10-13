// Playwright 原始异常会带 URL、选择器、页面文本或请求体，不能整体输出；
// 这里只提取固定形态的类别（调用名、网络错误码、超时、页面关闭等），让失败仍可定位。
const API =
  /^(?:[A-Za-z]*Error: )?((?:page|frame|locator|browserType|browser|context|request|response)\.[a-zA-Z]+):/
const ERROR_NAME = /^([A-Za-z]*Error)\b/
const CATEGORIES = [
  /\bnet::ERR_[A-Z0-9_]+/,
  /\bTest timeout of \d+ms exceeded/,
  /\bTimeout \d+ms exceeded/,
  /\bTarget page, context or browser has been closed/,
  /\bTarget crashed/,
  /\bis interrupted by another navigation/,
  /\b[Ff]rame was detached/,
  /\bBrowser has been disconnected/i,
  /\bBrowser closed/,
  /\bProtocol error \([A-Za-z.]+\)/,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/,
  /\bRead-only evidence query failed \((?:connect|timeout|ssl|auth|sql|container|unknown)\)/,
]

export function safeDiagnostic(message: string | undefined) {
  // 只看首行：后续的调用日志会回显导航 URL 与页面内容。
  const first = message?.split('\n', 1)[0] ?? ''
  const parts = [API.exec(first)?.[1] ?? ERROR_NAME.exec(first)?.[1]]
  for (const pattern of CATEGORIES) parts.push(pattern.exec(first)?.[0])
  const safe = parts.filter(Boolean)
  return safe.length > 0 ? safe.join(': ') : 'unclassified'
}

export type PsqlFailure = 'connect' | 'timeout' | 'ssl' | 'auth' | 'sql' | 'container' | 'unknown'

// 按顺序匹配：docker 与认证先于连接类（认证失败也以 "connection to server ... failed" 开头）；
// Neon 代理的唤醒失败以 ERROR: 开头，所以连接类要先于 sql。statement timeout 属于查询本身，归 sql。
const PSQL_PATTERNS: [PsqlFailure, RegExp][] = [
  [
    'container',
    /Error response from daemon|No such container|Cannot connect to the Docker daemon|is not running/i,
  ],
  [
    'auth',
    /password authentication failed|authentication failed|no pg_hba\.conf entry|role ".*" does not exist|database ".*" does not exist|password is required/i,
  ],
  ['sql', /canceling statement due to statement timeout/i],
  ['ssl', /\bSSL\b|unexpected eof/i],
  ['timeout', /timeout expired|timed out/i],
  [
    'connect',
    /could not connect|connection refused|could not translate host name|server closed the connection|terminating connection|connection to server .* failed|no connection to the server|connection reset|network is unreachable|compute node|compute is starting|endpoint is starting/i,
  ],
  ['sql', /^(?:psql:[^\n]*?)?(?:ERROR|FATAL):/im],
]

export const TRANSIENT_PSQL_FAILURES: ReadonlySet<PsqlFailure> = new Set([
  'connect',
  'timeout',
  'ssl',
])

// psql/docker 的 stderr 含主机名、SQL 片段或数据，只返回固定类别，原文不外传。
export function classifyPsqlFailure(stderr: string, code: number | null): PsqlFailure {
  // 跳过 psql 回显的 SQL 行（LINE n: 与箭头行），避免查询文本误触发连接类模式。
  const text = stderr
    .split('\n')
    .filter((line) => !/^\s*(?:LINE \d+:|\^)/.test(line) && !/^\s/.test(line))
    .join('\n')
  for (const [category, pattern] of PSQL_PATTERNS) if (pattern.test(text)) return category
  // psql 退出码 2 表示连接异常，3 表示脚本错误；docker exec 自身失败为 125-127。
  if (code === 2) return 'connect'
  if (code === 3) return 'sql'
  if (code !== null && code >= 125 && code <= 127) return 'container'
  return 'unknown'
}
