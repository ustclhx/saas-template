import { m } from '@web/paraglide/messages.js'

/**
 * 下架原因：后台存稳定的原因码，读取时按当前语言翻译；其他来源（如 MCP）写入的自由文本原样显示。
 * 客户端安全（只依赖文案），供后台审核页与「我的作品」共用。
 */
export const STUDIO_REMOVAL_REASONS = [
  'copyright',
  'sexual',
  'violence',
  'hate',
  'spam',
  'other',
] as const
export type StudioRemovalReason = (typeof STUDIO_REMOVAL_REASONS)[number]

const labels: Record<StudioRemovalReason, () => string> = {
  copyright: m.studio_removal_reason_copyright,
  sexual: m.studio_removal_reason_sexual,
  violence: m.studio_removal_reason_violence,
  hate: m.studio_removal_reason_hate,
  spam: m.studio_removal_reason_spam,
  other: m.studio_removal_reason_other,
}

export const isStudioRemovalReason = (value: string): value is StudioRemovalReason =>
  Object.hasOwn(labels, value)

/** 原因码 → 当前语言的文字；不是原因码时原样返回 */
export function studioRemovalReasonLabel(reason: string): string {
  return isStudioRemovalReason(reason) ? labels[reason]() : reason
}
