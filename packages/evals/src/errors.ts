/** 配置错误（退出码 2）：在任何模型调用前发现，不写报告（design D9） */
export class EvalConfigError extends Error {
  override readonly name = 'EvalConfigError'
}

export const EXIT = {
  ok: 0,
  failed: 1,
  config: 2,
  budget: 3,
  regression: 4,
} as const

/** 错误信息只保留消息正文，去掉可能携带凭据的 URL 与请求头值 */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(
      /((?:authorization|x-api-key|x-goog-api-key|cf-aig-authorization)\s*[:=]\s*)\S+/gi,
      '$1<redacted>',
    )
    .slice(0, 500)
}
