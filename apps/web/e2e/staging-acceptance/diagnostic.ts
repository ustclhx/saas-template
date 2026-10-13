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
]

export function safeDiagnostic(message: string | undefined) {
  // 只看首行：后续的调用日志会回显导航 URL 与页面内容。
  const first = message?.split('\n', 1)[0] ?? ''
  const parts = [API.exec(first)?.[1] ?? ERROR_NAME.exec(first)?.[1]]
  for (const pattern of CATEGORIES) parts.push(pattern.exec(first)?.[0])
  const safe = parts.filter(Boolean)
  return safe.length > 0 ? safe.join(': ') : 'unclassified'
}
