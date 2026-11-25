import {
  auditLog,
  bulkJobFloorSql,
  type Database,
  probeBulkJob,
  refundRequest,
  user,
} from '@saas/db'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@saas/email/queue'
import type { QueueProducer } from '@saas/platform'
import { BULK_JOB_TIME_FLOOR, type BulkJobOutcome, bulkJobOutcome } from '@saas/shared/bulk-job'
import { withRequestId } from '@saas/shared/log'
import { and, asc, eq, gte, isNotNull, lte, ne, notExists, type SQL, sql } from 'drizzle-orm'
import type { RefundNotification } from './refunds.ts'

export interface RefundMailOptions {
  db: Database
  queue: Pick<QueueProducer<EmailQueueMessage>, 'send'>
  appName: string
  supportEmail: string
}
const action = (status: string) => `billing.refund_email.${status}.queued`

/** Reviewed requests themselves are durable pending work; markers are written after queue acceptance. */
export async function notifyRefundRequest(
  options: RefundMailOptions,
  notification: RefundNotification,
) {
  const { request } = notification
  if (request.status === 'pending' || !request.contactEmail) return
  const [sent] = await options.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, request.id), eq(auditLog.action, action(request.status))))
  if (sent) return
  const [applicant] = await options.db
    .select({ locale: user.locale })
    .from(user)
    .where(eq(user.id, request.userId))
  const message = parseEmailQueueMessage({
    v: 1,
    template: 'refund-update',
    to: request.contactEmail,
    locale: applicant?.locale ?? null,
    appName: options.appName,
    idempotencyKey: `refund-notification:${request.id}:${request.status}`,
    props: {
      status: request.status,
      amount: request.approvedAmount,
      currency: 'USD',
      note: request.reviewNote ?? '',
      supportEmail: options.supportEmail,
    },
  })
  if (!message) throw new Error('Invalid refund notification')
  await options.queue.send(withRequestId(message))
  await options.db.insert(auditLog).values({
    workspaceId: request.workspaceId,
    action: action(request.status),
    targetType: 'refund_request',
    targetId: request.id,
  })
}

/** 每轮最多补发的退款邮件数（add-ops-safeguards 登记的上限） */
export const REFUND_NOTIFICATION_LIMIT = 100

/**
 * Recover crashes between the saved review/settlement and notification; never move money.
 * 批量补发（定时任务）只发送 updated_at 在时间下限与数据库当前时间之间的申请，区间外的保留并告警；
 * 指定申请 ID 的即时发送不做探测，避免请求路径多一次往返。
 */
export async function flushRefundNotifications(
  options: RefundMailOptions,
  input: { requestId?: string } = {},
): Promise<{ queued: number; failures: string[]; guard?: BulkJobOutcome }> {
  const unsent = and(
    ne(refundRequest.status, 'pending'),
    input.requestId ? eq(refundRequest.id, input.requestId) : undefined,
    isNotNull(refundRequest.contactEmail),
    notExists(
      options.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, sql`${refundRequest.id}::text`),
            eq(
              auditLog.action,
              sql`'billing.refund_email.' || ${refundRequest.status} || '.queued'`,
            ),
          ),
        ),
    ),
  ) as SQL
  const batch = !input.requestId
  const outOfRange = batch
    ? (
        await probeBulkJob(
          options.db,
          sql`select count(*) from ${refundRequest} where ${unsent} and (${refundRequest.updatedAt}<${bulkJobFloorSql} or ${refundRequest.updatedAt}>now())`,
        )
      ).outOfRange
    : 0
  const rows = await options.db
    .select()
    .from(refundRequest)
    .where(
      batch
        ? and(
            unsent,
            gte(refundRequest.updatedAt, BULK_JOB_TIME_FLOOR),
            lte(refundRequest.updatedAt, sql`now()`),
          )
        : unsent,
    )
    .orderBy(asc(refundRequest.updatedAt), asc(refundRequest.id))
    .limit(REFUND_NOTIFICATION_LIMIT)
  let queued = 0
  const failures: string[] = []
  for (const request of rows) {
    try {
      await notifyRefundRequest(options, {
        request,
        contactEmail: request.contactEmail as string,
        idempotencyKey: `refund-notification:${request.id}:${request.status}`,
      })
      queued++
    } catch {
      failures.push(request.id)
      await options.db.insert(auditLog).values({
        workspaceId: request.workspaceId,
        action: 'billing.refund_email.failed',
        targetType: 'refund_request',
        targetId: request.id,
      })
    }
  }
  return {
    queued,
    failures,
    ...(batch && {
      guard: bulkJobOutcome({ processed: rows.length, cap: REFUND_NOTIFICATION_LIMIT, outOfRange }),
    }),
  }
}
