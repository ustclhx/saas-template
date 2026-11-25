import type { Database } from '@saas/db'
import { account, adminStepUp, auditLog, twoFactor, user, verification } from '@saas/db/schema'
import type { RateLimiter } from '@saas/platform'
import { AppError, newId } from '@saas/shared'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { SendAuthEmail } from './email.ts'
import { verifyPassword } from './password.ts'

/**
 * 后台敏感操作的重新验证（openspec add-admin-step-up design.md 决策 3–5，tasks 2.1 / 2.3）。
 *
 * 全部方式都在当前会话内完成：不创建、不替换会话，也不写 Cookie；成功后 upsert `admin_step_up`
 * （按会话一行，绝对有效期）并写审计。为什么不直接调用 Better Auth 的 2FA 端点：
 * - `/two-factor/verify-totp` 不返回命中的时间窗，无法做「同一时间窗只接受一次」（上游 issue #10387）；
 *   且 `twoFactor.verified !== true` 时已登录分支会新建会话并删除旧会话（better-auth 1.7.7
 *   dist/plugins/two-factor/totp/index.mjs），违背「不替换会话」。
 * - 已登录分支不计失败次数、不锁定（verify-two-factor.mjs 的 beginAttempt 为空实现）。
 * 因此用 Better Auth 自己的 `symmetricDecrypt` / `symmetricEncrypt` 与 `secretConfig` 读写
 * `two_factor` 行，算法与参数同插件默认值（HOTP-SHA1、6 位、30 秒、窗口 ±1，备用码 `encrypted` 存储），
 * 由集成测试锁定与插件的兼容性：升级 better-auth 改了存储格式时测试先失败。
 */

export type StepUpMethod = 'totp' | 'backup_code' | 'email_otp' | 'password' | 'rescue'

/** 方式展示顺序：最强在前（passkey 预留，优先级高于 TOTP） */
const METHOD_ORDER: readonly StepUpMethod[] = [
  'totp',
  'backup_code',
  'email_otp',
  'password',
  'rescue',
]

export const STEP_UP_CODE_LENGTH = 6
export const STEP_UP_CODE_MINUTES = 10
export const STEP_UP_CODE_ATTEMPTS = 3
export const STEP_UP_RESEND_SECONDS = 60
/** 账号级连续失败：窗口内达到次数即锁定（design.md 决策 3） */
export const STEP_UP_FAILURE_WINDOW_MINUTES = 5
export const STEP_UP_FAILURE_LIMIT = 5
export const STEP_UP_LOCK_MINUTES = 15

const TOTP_PERIOD_SECONDS = 30
const TOTP_DIGITS = 6
const TOTP_WINDOW = 1

/** `auth.$context` 中的 `secretConfig`（单密钥为字符串，多版本密钥为对象） */
export type AuthSecretConfig = Parameters<typeof symmetricDecrypt>[0]['key']

export interface StepUpSessionRef {
  readonly id: string
  readonly userId: string
}

export interface AdminStepUpDeps {
  readonly db: Database
  /** `(await auth.$context).secretConfig`：解密 2FA 密钥与备用码 */
  readonly secretConfig: AuthSecretConfig
  /** 模板配置 `admin.stepUpMinutes` */
  readonly stepUpMinutes: number
  /** RL_AUTH；未提供时只用于单元测试 */
  readonly rateLimiter?: RateLimiter | undefined
  readonly clientIp?: string | null | undefined
  readonly sendEmail: SendAuthEmail
  /** 救援开关（`ADMIN_STEP_UP_RESCUE`）与引导名单（`BOOTSTRAP_ADMIN_EMAILS`） */
  readonly rescue?: {
    readonly enabled: boolean
    readonly bootstrapEmails: string | undefined
  }
  readonly now?: () => Date
  /**
   * 写 `verification` 行时追加的项目列：衍生项目给该表加了必填列（如多站点的 `site`）时提供。
   * 每次发码或校验在事务前按用户调用一次（事务内不再另取连接）；模板写入的列优先，不会被覆盖。
   */
  readonly verificationColumns?: (
    userId: string,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export interface StepUpOptions {
  readonly methods: readonly StepUpMethod[]
  /** 救援开关已开启（后台显示警示条，与当前管理员是否在名单内无关） */
  readonly rescueMode: boolean
  /** 账号级锁定的解锁时间 */
  readonly lockedUntil: Date | null
  /** 打码后的收件邮箱（邮箱验证码 / 救援可用时） */
  readonly email: string | null
}

export interface StepUpStatus extends StepUpOptions {
  readonly verified: { readonly method: StepUpMethod; readonly expiresAt: Date } | null
  /** 当前会话已发出、仍有效的验证码 */
  readonly code: { readonly expiresAt: Date; readonly resendAt: Date } | null
}

export interface StepUpVerified {
  readonly method: StepUpMethod
  readonly expiresAt: Date
  readonly auditId: string
}

/** 救援开关的取值：`1` / `true` 视为开启，其余（含未设置）关闭 */
export function isRescueEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

export function parseBootstrapEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '***'
  const local = email.slice(0, at)
  return `${local.slice(0, Math.min(2, local.length - 1) || 1)}***${email.slice(at)}`
}

const codeIdentifier = (sessionId: string) => `admin-step-up:${sessionId}`
const lockIdentifier = (userId: string) => `admin-step-up-lock:${userId}`

const encoder = new TextEncoder()

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 常量时间比较十六进制 / 验证码字符串 */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 均匀分布的 6 位数字（拒绝采样，避免取模偏差） */
function randomCode(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 1_000_000)
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    const value = buffer[0] ?? 0
    if (value < limit) return String(value % 1_000_000).padStart(STEP_UP_CODE_LENGTH, '0')
  }
}

/** 验证码按会话加盐后只存哈希 */
const hashCode = (sessionId: string, code: string) => sha256Hex(`${sessionId}:${code}`)

/** RFC 4226 HOTP（HMAC-SHA1），与 @better-auth/utils/otp 的实现一致：密钥为原始字符串的 UTF-8 */
export async function hotp(secret: string, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const message = new ArrayBuffer(8)
  new DataView(message).setBigUint64(0, BigInt(counter), false)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = (mac[mac.length - 1] ?? 0) & 15
  const value =
    (((mac[offset] ?? 0) & 127) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0)
  return String(value % 10 ** digits).padStart(digits, '0')
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / (TOTP_PERIOD_SECONDS * 1000))

function stepUpError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return new AppError(code, message, {
    status,
    ...(details ? { details, publicDetails: details } : {}),
  })
}

export const STEP_UP_METHOD_UNAVAILABLE = 'STEP_UP_METHOD_UNAVAILABLE'
export const STEP_UP_INVALID = 'STEP_UP_INVALID'
export const STEP_UP_CODE_EXPIRED = 'STEP_UP_CODE_EXPIRED'
export const STEP_UP_LOCKED = 'STEP_UP_LOCKED'
export const STEP_UP_RATE_LIMITED = 'STEP_UP_RATE_LIMITED'
export const STEP_UP_RESEND_COOLDOWN = 'STEP_UP_RESEND_COOLDOWN'

const lockedError = (lockedUntil: Date) =>
  stepUpError(STEP_UP_LOCKED, 'Re-verification is temporarily locked', 429, {
    lockedUntil: lockedUntil.toISOString(),
  })

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Executor = Database | Tx

interface AccountFacts {
  readonly email: string
  readonly emailVerified: boolean
  readonly twoFactorEnabled: boolean
  readonly hasPassword: boolean
}

/** 已完成绑定的 2FA 行（`verified` 不为 false），与可用方式计算、插件登录判断一致 */
const activeTwoFactor = (userId: string) =>
  and(eq(twoFactor.userId, userId), sql`${twoFactor.verified} is not false`)

async function accountFacts(db: Executor, userId: string): Promise<AccountFacts | null> {
  const [row] = await db
    .select({
      email: user.email,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      totp: twoFactor.id,
      password: account.password,
    })
    .from(user)
    .leftJoin(
      twoFactor,
      and(eq(twoFactor.userId, user.id), sql`${twoFactor.verified} is not false`),
    )
    .leftJoin(account, and(eq(account.userId, user.id), eq(account.providerId, 'credential')))
    .where(eq(user.id, userId))
    .limit(1)
  if (!row) return null
  return {
    email: row.email,
    emailVerified: row.emailVerified === true,
    // 只有完成绑定（two_factor 行已验证）的账号才算开启，与插件的登录判断一致
    twoFactorEnabled: row.twoFactorEnabled === true && row.totp !== null,
    hasPassword: Boolean(row.password),
  }
}

/**
 * 可用方式（design.md 决策 3，不允许降级）：开启 2FA → TOTP / 备用码；否则已验证邮箱 → 邮箱验证码，
 * 有密码再加密码。救援开关开启且邮箱在引导名单内时，常规方式中没有邮箱验证码的账号（即开启了 2FA）
 * 额外可用 `rescue`（同样发到已验证邮箱，方式单独记录）。
 */
export function methodsFor(facts: AccountFacts, rescue: AdminStepUpDeps['rescue']): StepUpMethod[] {
  const methods = new Set<StepUpMethod>()
  if (facts.twoFactorEnabled) {
    methods.add('totp')
    methods.add('backup_code')
  } else {
    if (facts.emailVerified) methods.add('email_otp')
    if (facts.hasPassword) methods.add('password')
  }
  if (
    rescue?.enabled &&
    facts.emailVerified &&
    !methods.has('email_otp') &&
    parseBootstrapEmails(rescue.bootstrapEmails).has(facts.email.trim().toLowerCase())
  )
    methods.add('rescue')
  return METHOD_ORDER.filter((method) => methods.has(method))
}

/** 只读：账号当前可用的方式（用于 `STEP_UP_REQUIRED` 的 details，不需要解密密钥） */
export async function listStepUpMethods(
  db: Database,
  userId: string,
  rescue?: AdminStepUpDeps['rescue'],
): Promise<StepUpMethod[]> {
  const facts = await accountFacts(db, userId)
  return facts ? methodsFor(facts, rescue) : []
}

interface LockState {
  readonly failures: number
  readonly lockedUntil: string | null
}

async function readLock(db: Executor, userId: string, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(
      and(eq(verification.identifier, lockIdentifier(userId)), gt(verification.expiresAt, now)),
    )
    .limit(1)
  if (!row) return null
  const state = parseLock(row.value)
  const until = state.lockedUntil ? new Date(state.lockedUntil) : null
  return until && until > now ? until : null
}

function parseLock(value: string): LockState {
  try {
    const parsed = JSON.parse(value) as Partial<LockState>
    return {
      failures: Number.isSafeInteger(parsed.failures) ? (parsed.failures as number) : 0,
      lockedUntil: typeof parsed.lockedUntil === 'string' ? parsed.lockedUntil : null,
    }
  } catch {
    return { failures: 0, lockedUntil: null }
  }
}

/** 同一账号的重新验证串行执行：防止并发提交绕过尝试次数、同窗 TOTP 与备用码检查 */
async function lockAccount(tx: Tx, userId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`admin-step-up:${userId}`}, 0))`,
  )
}

type VerificationInsert = typeof verification.$inferInsert
/** 模板自己写入的 verification 列；项目新增的必填列由 verificationColumns 补齐 */
type VerificationTemplateRow = Pick<
  VerificationInsert,
  'id' | 'identifier' | 'value' | 'expiresAt'
> &
  Partial<Pick<VerificationInsert, 'createdAt' | 'updatedAt'>>

export function createAdminStepUp(deps: AdminStepUpDeps) {
  // 本次调用的项目附加列，以会话引用为键在内部函数间传递（不改公开的 StepUpSessionRef）
  const extraColumns = new WeakMap<StepUpSessionRef, Record<string, unknown>>()
  async function prepareColumns(session: StepUpSessionRef) {
    if (deps.verificationColumns)
      extraColumns.set(session, await deps.verificationColumns(session.userId))
  }
  /**
   * 模板写入的列加上项目附加列。附加列的类型来自项目钩子，项目给表加了必填列（如 site）时
   * 模板这里无法静态证明它们存在，因此在这一处断言为完整的插入类型，调用处不必再断言。
   */
  function verificationRow(session: StepUpSessionRef, row: VerificationTemplateRow) {
    return { ...extraColumns.get(session), ...row } as VerificationInsert
  }
  const { db } = deps
  const now = () => deps.now?.() ?? new Date()
  const ip = deps.clientIp ?? null

  async function limit(key: string) {
    if (!deps.rateLimiter) return
    const { success } = await deps.rateLimiter.limit('auth', key)
    if (!success) throw stepUpError(STEP_UP_RATE_LIMITED, 'Too many requests, try again later', 429)
  }

  /** 按 IP 与账号两个维度限流（RL_AUTH，见 protection.ts 的限流语义） */
  async function throttle(session: StepUpSessionRef) {
    await limit(`stepup:ip:${ip ?? 'unknown'}`)
    await limit(`stepup:${session.userId}`)
  }

  async function requireFacts(executor: Executor, session: StepUpSessionRef) {
    const facts = await accountFacts(executor, session.userId)
    if (!facts) throw stepUpError(STEP_UP_METHOD_UNAVAILABLE, 'No verification method', 400)
    return facts
  }

  async function options(session: StepUpSessionRef): Promise<StepUpOptions> {
    const facts = await accountFacts(db, session.userId)
    const methods = facts ? methodsFor(facts, deps.rescue) : []
    const mailable = methods.includes('email_otp') || methods.includes('rescue')
    return {
      methods,
      rescueMode: deps.rescue?.enabled === true,
      lockedUntil: await readLock(db, session.userId, now()),
      email: facts && mailable ? maskEmail(facts.email) : null,
    }
  }

  async function status(session: StepUpSessionRef): Promise<StepUpStatus> {
    const at = now()
    const [opts, [verified], [code]] = await Promise.all([
      options(session),
      db
        .select({ method: adminStepUp.method, expiresAt: adminStepUp.expiresAt })
        .from(adminStepUp)
        .where(
          and(
            eq(adminStepUp.sessionId, session.id),
            eq(adminStepUp.userId, session.userId),
            gt(adminStepUp.expiresAt, at),
          ),
        )
        .limit(1),
      db
        .select({ createdAt: verification.createdAt, expiresAt: verification.expiresAt })
        .from(verification)
        .where(
          and(
            eq(verification.identifier, codeIdentifier(session.id)),
            gt(verification.expiresAt, at),
          ),
        )
        .limit(1),
    ])
    return {
      ...opts,
      verified: verified
        ? { method: verified.method as StepUpMethod, expiresAt: verified.expiresAt }
        : null,
      code: code
        ? {
            expiresAt: code.expiresAt,
            resendAt: new Date(code.createdAt.getTime() + STEP_UP_RESEND_SECONDS * 1000),
          }
        : null,
    }
  }

  /** 记一次失败；达到上限即锁定并写审计。在调用方的事务与账号锁内执行。 */
  async function recordFailure(tx: Tx, session: StepUpSessionRef, method: StepUpMethod) {
    const at = now()
    const identifier = lockIdentifier(session.userId)
    const [row] = await tx
      .select({ id: verification.id, value: verification.value })
      .from(verification)
      .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, at)))
      .limit(1)
    const failures = (row ? parseLock(row.value).failures : 0) + 1
    const locked = failures >= STEP_UP_FAILURE_LIMIT
    const lockedUntil = locked ? new Date(at.getTime() + STEP_UP_LOCK_MINUTES * 60_000) : null
    const value = JSON.stringify({ failures, lockedUntil: lockedUntil?.toISOString() ?? null })
    if (row) {
      await tx
        .update(verification)
        .set({ value, updatedAt: at, ...(lockedUntil ? { expiresAt: lockedUntil } : {}) })
        .where(eq(verification.id, row.id))
    } else {
      await tx.delete(verification).where(eq(verification.identifier, identifier))
      await tx.insert(verification).values(
        verificationRow(session, {
          id: newId(),
          identifier,
          value,
          expiresAt:
            lockedUntil ?? new Date(at.getTime() + STEP_UP_FAILURE_WINDOW_MINUTES * 60_000),
        }),
      )
    }
    if (!lockedUntil) return null
    await tx.insert(auditLog).values({
      action: 'admin.step_up.locked',
      actorUserId: session.userId,
      targetType: 'user',
      targetId: session.userId,
      ip,
      meta: { method, failures, lockedUntil: lockedUntil.toISOString() },
    })
    return lockedUntil
  }

  /**
   * 失败写入必须提交（回滚会抹掉计数），所以校验在事务内返回结果而不是抛错，
   * 事务提交后再把失败转换为错误。
   */
  type Outcome =
    | { readonly ok: true; readonly value: StepUpVerified }
    | { readonly ok: false; readonly error: AppError }

  async function fail(
    tx: Tx,
    session: StepUpSessionRef,
    method: StepUpMethod,
    details?: Record<string, unknown>,
  ): Promise<Outcome> {
    const lockedUntil = await recordFailure(tx, session, method)
    return {
      ok: false,
      error: lockedUntil
        ? lockedError(lockedUntil)
        : stepUpError(STEP_UP_INVALID, 'Verification failed', 400, { method, ...details }),
    }
  }

  async function succeed(
    tx: Tx,
    session: StepUpSessionRef,
    method: StepUpMethod,
    totp: number | null,
  ): Promise<Outcome> {
    const at = now()
    const expiresAt = new Date(at.getTime() + deps.stepUpMinutes * 60_000)
    await tx
      .insert(adminStepUp)
      .values({
        sessionId: session.id,
        userId: session.userId,
        method,
        verifiedAt: at,
        expiresAt,
        lastTotpStep: totp,
      })
      .onConflictDoUpdate({
        target: adminStepUp.sessionId,
        set: {
          userId: session.userId,
          method,
          verifiedAt: at,
          expiresAt,
          // 换用其他方式时保留已用过的时间窗，避免同窗 TOTP 在本会话被再次接受
          lastTotpStep: sql`coalesce(excluded.last_totp_step, ${adminStepUp.lastTotpStep})`,
        },
      })
    await tx.delete(verification).where(eq(verification.identifier, lockIdentifier(session.userId)))
    const auditId = newId()
    await tx.insert(auditLog).values({
      id: auditId,
      action: 'admin.step_up.verified',
      actorUserId: session.userId,
      targetType: 'user',
      targetId: session.userId,
      ip,
      meta: { method, ip, expiresAt: expiresAt.toISOString() },
    })
    return { ok: true, value: { method, expiresAt, auditId } }
  }

  async function verifyEmailCode(
    tx: Tx,
    session: StepUpSessionRef,
    method: 'email_otp' | 'rescue',
    code: string,
  ): Promise<Outcome> {
    const at = now()
    const [row] = await tx
      .select({ id: verification.id, value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, codeIdentifier(session.id)))
      .for('update')
      .limit(1)
    const [attemptsText, purpose, hash] = row ? row.value.split(':') : []
    const attempts = Number(attemptsText)
    if (!row || row.expiresAt <= at || purpose !== method || !hash || !Number.isInteger(attempts)) {
      return {
        ok: false,
        error: stepUpError(STEP_UP_CODE_EXPIRED, 'Request a new verification code', 400),
      }
    }
    if (safeEqual(await hashCode(session.id, code), hash)) {
      // 原子消费：行锁内删除，并发的第二次提交读不到这一行
      await tx.delete(verification).where(eq(verification.id, row.id))
      return succeed(tx, session, method, null)
    }
    const used = attempts + 1
    if (used >= STEP_UP_CODE_ATTEMPTS) {
      await tx.delete(verification).where(eq(verification.id, row.id))
    } else {
      await tx
        .update(verification)
        .set({ value: `${used}:${purpose}:${hash}`, updatedAt: at })
        .where(eq(verification.id, row.id))
    }
    return fail(tx, session, method, { attemptsRemaining: STEP_UP_CODE_ATTEMPTS - used })
  }

  async function verifyTotp(tx: Tx, session: StepUpSessionRef, code: string): Promise<Outcome> {
    const [row] = await tx
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(activeTwoFactor(session.userId))
      // 行锁让同一账号并发的 TOTP 校验串行：后到者读到前者写入的 last_totp_step
      .for('update')
      .limit(1)
    if (!row) return fail(tx, session, 'totp')
    const secret = await symmetricDecrypt({ key: deps.secretConfig, data: row.secret })
    const current = totpStep(now())
    let matched: number | null = null
    for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
      if (safeEqual(code, await hotp(secret, current + offset))) matched = current + offset
    }
    if (matched === null) return fail(tx, session, 'totp')
    // 同一账号所有会话共享「已用时间窗」：同窗或更早的验证码一律拒绝（上游 issue #10387）
    const [used] = await tx
      .select({ step: sql<string | null>`max(${adminStepUp.lastTotpStep})` })
      .from(adminStepUp)
      .where(eq(adminStepUp.userId, session.userId))
    if (used?.step !== null && used?.step !== undefined && matched <= Number(used.step))
      return fail(tx, session, 'totp', { reason: 'replayed' })
    return succeed(tx, session, 'totp', matched)
  }

  async function verifyBackupCode(
    tx: Tx,
    session: StepUpSessionRef,
    code: string,
  ): Promise<Outcome> {
    const [row] = await tx
      .select({ id: twoFactor.id, backupCodes: twoFactor.backupCodes })
      .from(twoFactor)
      .where(activeTwoFactor(session.userId))
      .for('update')
      .limit(1)
    if (!row) return fail(tx, session, 'backup_code')
    let codes: unknown
    try {
      codes = JSON.parse(await symmetricDecrypt({ key: deps.secretConfig, data: row.backupCodes }))
    } catch {
      codes = null
    }
    if (!Array.isArray(codes) || !codes.includes(code)) return fail(tx, session, 'backup_code')
    // 与插件一致：成功即从列表移除，重新加密写回（行锁内，同一备用码只能用一次）
    const remaining = codes.filter((c) => c !== code)
    await tx
      .update(twoFactor)
      .set({
        backupCodes: await symmetricEncrypt({
          key: deps.secretConfig,
          data: JSON.stringify(remaining),
        }),
        updatedAt: now(),
      })
      .where(eq(twoFactor.id, row.id))
    return succeed(tx, session, 'backup_code', null)
  }

  async function verifyPasswordMethod(
    tx: Tx,
    session: StepUpSessionRef,
    password: string,
  ): Promise<Outcome> {
    const [row] = await tx
      .select({ hash: account.password })
      .from(account)
      .where(and(eq(account.userId, session.userId), eq(account.providerId, 'credential')))
      .limit(1)
    if (!row?.hash || !(await verifyPassword({ hash: row.hash, password })))
      return fail(tx, session, 'password')
    return succeed(tx, session, 'password', null)
  }

  return {
    options,
    status,

    /** 向已验证邮箱发送验证码（`email_otp` 或 `rescue`），60 秒内不重发；旧码随之作废 */
    async sendCode(session: StepUpSessionRef, method: 'email_otp' | 'rescue' = 'email_otp') {
      await throttle(session)
      await prepareColumns(session)
      const at = now()
      const code = randomCode()
      const sent = await db.transaction(async (tx) => {
        await lockAccount(tx, session.userId)
        const lockedUntil = await readLock(tx, session.userId, at)
        if (lockedUntil) throw lockedError(lockedUntil)
        const facts = await requireFacts(tx, session)
        if (!methodsFor(facts, deps.rescue).includes(method))
          throw stepUpError(STEP_UP_METHOD_UNAVAILABLE, 'Verification method unavailable', 400, {
            method,
          })
        const identifier = codeIdentifier(session.id)
        const [active] = await tx
          .select({ createdAt: verification.createdAt })
          .from(verification)
          .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, at)))
          .limit(1)
        const resendAt = active
          ? new Date(active.createdAt.getTime() + STEP_UP_RESEND_SECONDS * 1000)
          : null
        if (resendAt && resendAt > at)
          throw stepUpError(STEP_UP_RESEND_COOLDOWN, 'Wait before requesting another code', 429, {
            resendAt: resendAt.toISOString(),
          })
        await tx.delete(verification).where(eq(verification.identifier, identifier))
        const expiresAt = new Date(at.getTime() + STEP_UP_CODE_MINUTES * 60_000)
        await tx.insert(verification).values(
          verificationRow(session, {
            id: newId(),
            identifier,
            value: `0:${method}:${await hashCode(session.id, code)}`,
            expiresAt,
            createdAt: at,
            updatedAt: at,
          }),
        )
        return { to: facts.email, expiresAt }
      })
      await deps.sendEmail({
        type: 'admin-step-up-code',
        to: sent.to,
        otp: code,
        expiresInMinutes: STEP_UP_CODE_MINUTES,
      })
      return {
        method,
        email: maskEmail(sent.to),
        expiresAt: sent.expiresAt,
        resendAt: new Date(at.getTime() + STEP_UP_RESEND_SECONDS * 1000),
      }
    },

    /**
     * 校验一次重新验证。成功 upsert 当前会话的 `admin_step_up` 并写审计 `admin.step_up.verified`；
     * 失败计入账号级失败次数，达到上限锁定并写 `admin.step_up.locked`。
     */
    async verify(
      session: StepUpSessionRef,
      input: { readonly method: StepUpMethod; readonly code?: string; readonly password?: string },
    ): Promise<StepUpVerified> {
      await throttle(session)
      await prepareColumns(session)
      const outcome = await db.transaction(async (tx): Promise<Outcome> => {
        await lockAccount(tx, session.userId)
        const lockedUntil = await readLock(tx, session.userId, now())
        if (lockedUntil) return { ok: false, error: lockedError(lockedUntil) }
        const facts = await requireFacts(tx, session)
        if (!methodsFor(facts, deps.rescue).includes(input.method))
          return {
            ok: false,
            error: stepUpError(STEP_UP_METHOD_UNAVAILABLE, 'Verification method unavailable', 400, {
              method: input.method,
              methods: methodsFor(facts, deps.rescue),
            }),
          }
        const code = (input.code ?? '').replace(/\s+/g, '')
        switch (input.method) {
          case 'email_otp':
          case 'rescue':
            return verifyEmailCode(tx, session, input.method, code)
          case 'totp':
            return verifyTotp(tx, session, code)
          case 'backup_code':
            return verifyBackupCode(tx, session, code)
          case 'password':
            return verifyPasswordMethod(tx, session, input.password ?? '')
        }
      })
      if (!outcome.ok) throw outcome.error
      return outcome.value
    },
  }
}

export type AdminStepUpService = ReturnType<typeof createAdminStepUp>
