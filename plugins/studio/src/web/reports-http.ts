import { TURNSTILE_TOKEN_HEADER, verifyTurnstile } from '@saas/auth'
import { type Database, notFound, STUDIO_REPORT_REASONS } from '@saas/db'
import { AppError, toErrorResponse } from '@saas/shared'
import { log } from '@saas/shared/log'
import { z } from 'zod'
import type { StudioKind } from '../kinds.ts'
import { type StudioReportInput, submitStudioReport } from './reports.ts'
import type { InvalidateStudioWork } from './work-invalidation.ts'

const reportBody = z.strictObject({
  workId: z.uuid(),
  reason: z.enum(STUDIO_REPORT_REASONS),
  note: z.string().trim().max(500).optional(),
})
const encoder = new TextEncoder()
const responseHeaders = { 'cache-control': 'no-store' }

interface ReportHttpDeps {
  db: Database
  site: string | null
  kinds: readonly StudioKind[]
  unavailable?: boolean
  hideThreshold: number
  clientIp: string | null
  secret: string
  turnstileSecret?: string | undefined
  getUserId: (headers: Headers) => Promise<string | null>
  limit: (key: string) => Promise<{ success: boolean }>
  verifyTurnstile?: typeof verifyTurnstile
  invalidate?: InvalidateStudioWork
}

async function hashNetworkIdentifier(ip: string, secret: string) {
  // 为本站举报派生独立用途的 HMAC 密钥，数据库与限流键均不使用原始网络标识。
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`studio:report:ip:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(ip.toLowerCase()))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function handleStudioReport(request: Request, deps: ReportHttpDeps) {
  try {
    if (deps.unavailable)
      throw new AppError('STUDIO_UNAVAILABLE', 'Studio is unavailable', { status: 503 })
    if (deps.site === null) throw notFound()
    const ipHash = deps.clientIp ? await hashNetworkIdentifier(deps.clientIp, deps.secret) : null
    if (!(await deps.limit(`studio:report:ip:${ipHash ?? 'unknown'}`)).success)
      throw new AppError('RATE_LIMITED', 'Too many requests', { status: 429 })

    // 限定 JSON 请求，防止第三方页面用简单表单提交登录用户的举报。
    const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const body = reportBody.safeParse(
      contentType === 'application/json' ? await request.json().catch(() => undefined) : undefined,
    )
    if (!body.success) throw new AppError('INVALID_INPUT', 'Invalid report')

    const userId = await deps.getUserId(request.headers)
    let reporterKey: StudioReportInput['reporterKey']
    if (userId !== null) {
      reporterKey = `u:${userId}`
    } else {
      const token = request.headers.get(TURNSTILE_TOKEN_HEADER)
      const verify = deps.verifyTurnstile ?? verifyTurnstile
      if (
        !ipHash ||
        !deps.turnstileSecret ||
        !token ||
        !(await verify(deps.turnstileSecret, token, deps.clientIp))
      )
        throw new AppError('TURNSTILE_FAILED', 'Human verification failed', { status: 403 })
      reporterKey = `ip:${ipHash}`
    }

    await submitStudioReport(
      deps.db,
      {
        ...body.data,
        site: deps.site,
        kinds: deps.kinds,
        reporterKey,
      },
      { hideThreshold: deps.hideThreshold, invalidate: deps.invalidate },
    )
    return Response.json({ ok: true }, { headers: responseHeaders })
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    if (status >= 500)
      log.error('studio.report.request_failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      })
    return Response.json(body, {
      status,
      headers: {
        ...responseHeaders,
        ...(body.error.code === 'RATE_LIMITED' ? { 'retry-after': '60' } : {}),
      },
    })
  }
}
