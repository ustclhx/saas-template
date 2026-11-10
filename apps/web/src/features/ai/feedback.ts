import { z } from 'zod'

/**
 * 消息评分的共享类型与纯函数（add-subject-chat design 决策 6，specs/ai-chat「消息评分」）。
 * 浏览器与服务端都会导入本文件，数据库读写在 `feedback.server.ts`。
 */

export type FeedbackRating = 'up' | 'down'

export interface MessageFeedbackValue {
  readonly rating: FeedbackRating
  readonly comment: string | null
}

export const FEEDBACK_COMMENT_MAX_LENGTH = 1000

export const feedbackInputSchema = z.strictObject({
  slug: z.string().min(1).max(64),
  messageId: z.uuid(),
  /** null = 撤销 */
  rating: z.enum(['up', 'down']).nullable(),
  comment: z.string().max(FEEDBACK_COMMENT_MAX_LENGTH).optional(),
})
export type FeedbackInput = z.infer<typeof feedbackInputSchema>

const REDACTED = '[REDACTED]'

/**
 * 反馈文字入库前去除疑似密钥与令牌：反馈用于迭代提示词，会在后台被多人查看。
 * 只做常见形态的保守替换（API Key 前缀、Bearer、AWS Access Key、JWT、长十六进制/base64 串）。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr])_[A-Za-z0-9_]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/_-]{40,}={0,2}/g,
]

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, REDACTED), text)
}

/** 规范化反馈文字：去首尾空白、去密钥，空串存为 null */
export function normalizeFeedbackComment(comment: string | undefined): string | null {
  const trimmed = comment?.trim() ?? ''
  return trimmed ? scrubSecrets(trimmed).slice(0, FEEDBACK_COMMENT_MAX_LENGTH) : null
}
