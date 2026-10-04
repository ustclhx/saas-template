/**
 * `EMAIL_QUEUE` 的消息格式（tasks.md 3.2）：apps/web 投递、apps/jobs 消费，两端共用这里的定义。
 * 消息只放可 JSON 序列化的模板名、props、收件人、语言与幂等键，渲染与发送都在消费端完成。
 *
 * 本文件不依赖 React，经 `@saas/email/queue` 单独导出，producer 端引用时不会把 React Email 打进包里。
 */
import { z } from 'zod'
import type { EmailTemplateName, EmailTemplateProps } from './messages.ts'

export type { EmailTemplateName, EmailTemplateProps } from './messages.ts'

/** 消息格式版本：字段不兼容地变化时递增，消费端拒绝无法识别的版本。 */
export const EMAIL_QUEUE_MESSAGE_VERSION = 1

const url = z.url({ protocol: /^https?$/ })
const minutes = z.number().int().positive()

/** 各模板 props 的运行时校验，与 `EmailTemplateProps` 保持一致（类型不一致时编译报错）。 */
const templatePropsSchemas = {
  'verify-email': z.object({ url }),
  otp: z.object({
    otp: z.string().min(1),
    purpose: z.enum(['sign-in', 'email-verification', 'forget-password']),
    expiresInMinutes: minutes,
  }),
  'magic-link': z.object({ url, expiresInMinutes: minutes }),
  'reset-password': z.object({ url, expiresInMinutes: minutes }),
  'workspace-invitation': z.object({
    url,
    workspaceName: z.string().min(1),
    inviterName: z.string(),
    role: z.enum(['admin', 'member']),
    expiresInDays: z.number().int().positive(),
  }),
} satisfies { [N in EmailTemplateName]: z.ZodType<EmailTemplateProps[N]> }

const base = {
  v: z.literal(EMAIL_QUEUE_MESSAGE_VERSION),
  /** 收件人（单个地址） */
  to: z.email(),
  /** 收件人的 `user.locale`；未知时为 null，渲染时回退到默认语言 */
  locale: z.string().max(35).nullable(),
  /** 产品名（`template.config.ts` 的 `app.name`），用于邮件主题与正文 */
  appName: z.string().min(1),
  /** 投递时生成、重试时不变，作为服务商的幂等键（Resend 24 小时内去重） */
  idempotencyKey: z.string().min(1).max(256),
}

const messageSchema = z.discriminatedUnion(
  'template',
  (Object.keys(templatePropsSchemas) as EmailTemplateName[]).map((template) =>
    z.object({ ...base, template: z.literal(template), props: templatePropsSchemas[template] }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
)

type MessageBase = { readonly [K in keyof typeof base]: z.output<(typeof base)[K]> }

/** 队列消息：按模板名区分 props 的类型。 */
export type EmailQueueMessage = {
  readonly [N in EmailTemplateName]: MessageBase & {
    readonly template: N
    readonly props: EmailTemplateProps[N]
  }
}[EmailTemplateName]

/**
 * 校验队列中取出的消息体。格式错误返回 `null`（重试也不会变好，消费端直接确认并告警）；
 * 不在结果中带出原始内容，避免把收件人等信息写进日志。
 */
export function parseEmailQueueMessage(body: unknown): EmailQueueMessage | null {
  const result = messageSchema.safeParse(body)
  return result.success ? (result.data as EmailQueueMessage) : null
}
