import type { EmailTransportConfig } from '@saas/config'
import {
  createResendSender,
  type EmailTemplateName,
  type EmailTemplateProps,
  isEmailSendError,
  type RenderedEmail,
  renderEmail,
} from '@saas/email'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@saas/email/queue'

/**
 * EMAIL_QUEUE 消费者（tasks.md 3.2，specs/user-auth「认证邮件异步发送」）：
 * 校验消息 → 用 @saas/email 渲染 → 按 `EMAIL_TRANSPORT` 发送。
 *
 * - 发送成功：确认（ack）。
 * - 可重试的失败（Resend 5xx / 429 / 网络错误）：`retry()`，按指数退避延迟重投；
 *   重投时幂等键不变，Resend 在 24 小时内去重，不会重复发送。
 * - 不可重试的失败（其余 4xx、消息格式错误、链接非法）：确认并记录告警，不再重试。
 * - 达到最大投递次数仍失败：确认并记录 `email.dropped` 错误日志。不使用死信队列：
 *   死信队列需要在 Cloudflare 上另建队列，而认证邮件（验证码、魔法链接）过期很快，
 *   事后重放价值不大；需要时在 wrangler.jsonc 中加 `dead_letter_queue` 并去掉这里的提前确认。
 *
 * 日志只记录消息 ID、模板名、投递次数与错误摘要，不记录邮件内容；
 * 只有 log 通道会记录收件人（替代真实发送，供本地开发核对）。
 */

/** 首次投递 + 重试次数；与 wrangler.jsonc 中 consumer 的 `max_retries`（5）一致 */
export const EMAIL_MAX_ATTEMPTS = 6
const RETRY_BASE_DELAY_SECONDS = 30
const RETRY_MAX_DELAY_SECONDS = 15 * 60

/** 第 n 次投递失败后的重试延迟：30s、60s、120s……，最长 15 分钟 */
export function emailRetryDelaySeconds(attempts: number): number {
  return Math.min(
    RETRY_BASE_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1),
    RETRY_MAX_DELAY_SECONDS,
  )
}

/** 一次投递：发送渲染好的邮件，返回服务商的邮件 ID（log 通道为 null）。 */
type Deliver = (message: EmailQueueMessage, rendered: RenderedEmail) => Promise<string | null>

function createDeliver(transport: EmailTransportConfig): Deliver {
  if (transport.transport === 'log') {
    return async (message) => {
      console.log(
        JSON.stringify({ event: 'email.logged', template: message.template, to: message.to }),
      )
      return null
    }
  }
  const sender = createResendSender({
    apiKey: transport.apiKey,
    from: transport.from,
    ...(transport.replyTo === undefined ? {} : { replyTo: transport.replyTo }),
  })
  return async (message, rendered) => {
    const result = await sender.send({
      to: message.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: message.idempotencyKey,
    })
    return result.id
  }
}

function render(message: EmailQueueMessage): Promise<RenderedEmail> {
  // 联合类型下 TS 无法把 template 与 props 关联起来；parseEmailQueueMessage 已按模板校验 props
  return renderEmail(
    message.template as EmailTemplateName,
    message.props as EmailTemplateProps[EmailTemplateName],
    { locale: message.locale, appName: message.appName },
  )
}

export async function handleEmailBatch(
  batch: MessageBatch<unknown>,
  transport: EmailTransportConfig,
): Promise<void> {
  const deliver = createDeliver(transport)
  // 每条消息单独确认 / 重试，一条失败不影响同批的其他消息
  await Promise.all(batch.messages.map((message) => handleMessage(message, deliver, transport)))
}

async function handleMessage(
  message: Message<unknown>,
  deliver: Deliver,
  transport: EmailTransportConfig,
): Promise<void> {
  const meta = { id: message.id, attempts: message.attempts }
  const email = parseEmailQueueMessage(message.body)
  if (email === null) {
    console.warn(JSON.stringify({ event: 'email.invalid', ...meta }))
    message.ack()
    return
  }

  const context = { ...meta, template: email.template, transport: transport.transport }
  try {
    const providerId = await deliver(email, await render(email))
    console.log(JSON.stringify({ event: 'email.sent', ...context, providerId }))
    message.ack()
  } catch (error) {
    const failure = describeError(error)
    if (!failure.retryable) {
      console.warn(JSON.stringify({ event: 'email.failed', ...context, ...failure }))
      message.ack()
    } else if (message.attempts >= EMAIL_MAX_ATTEMPTS) {
      console.error(JSON.stringify({ event: 'email.dropped', ...context, ...failure }))
      message.ack()
    } else {
      const delaySeconds = emailRetryDelaySeconds(message.attempts)
      console.warn(JSON.stringify({ event: 'email.retry', ...context, ...failure, delaySeconds }))
      message.retry({ delaySeconds })
    }
  }
}

/**
 * 错误摘要：`EmailSendError` 的消息不含收件人与内容，可以记录；其他错误只记录类型名。
 * 渲染时链接非法（TypeError）属于消息本身的问题，重试无效；其他未知错误按暂时性失败重试。
 */
function describeError(error: unknown) {
  if (isEmailSendError(error)) {
    return { retryable: error.retryable, status: error.status, error: error.message }
  }
  const name = error instanceof Error ? error.name : typeof error
  return { retryable: !(error instanceof TypeError), error: name }
}
