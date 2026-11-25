/**
 * 会删除数据、销毁积分、调用外部平台写操作或批量对外发送的后台任务的声明与时间防护
 * （openspec add-ops-safeguards D1–D3）。纯函数，不依赖数据库或运行目标，两目标共用。
 */

/** 时间下限（Q5）：早于此时刻的截止时间或行时间一律视为写坏的数据，宁可不删 */
export const BULK_JOB_TIME_FLOOR = new Date('2024-01-01T00:00:00.000Z')
/** 应用时钟与数据库时钟的最大允许偏差 */
export const BULK_JOB_MAX_CLOCK_SKEW_MS = 5 * 60_000

export type BulkJobKind = 'delete' | 'destroy-credit' | 'external-write' | 'send'

/** 任务的防护声明：涉及删除/销毁/外部写/发送时必须有每轮上限、处理顺序与时间防护说明 */
export type BulkJobSafety =
  | { readonly kind: 'none'; readonly reason: string }
  | {
      readonly kind: BulkJobKind
      /** 每轮上限常量（正整数）；超出部分留到下一轮 */
      readonly cap: number
      /** 上限的计数单位，如「空间」「条」「次外部调用」 */
      readonly capUnit: string
      /** 处理顺序说明，应为最早到期优先 */
      readonly order: string
      /** 时间防护说明：截止时间、最小保留期与行时间区间 */
      readonly timeGuard: string
    }

export type BulkJobGuardReason =
  | 'clock-skew'
  | 'invalid-cutoff'
  | 'cutoff-before-floor'
  | 'cutoff-in-future'
  | 'retention-too-short'
  | 'rows-out-of-range'

export interface BulkJobTrip {
  readonly reason: BulkJobGuardReason
  /** 区间外的行数等计数；不含任何用户数据 */
  readonly count?: number
}

/** 任务一轮的防护结果，由任务实现返回，jobs 负责日志与告警 */
export interface BulkJobOutcome {
  /** 本轮已执行动作的数量（与 cap 同单位） */
  readonly processed: number
  readonly capReached: boolean
  readonly tripped: readonly BulkJobTrip[]
}

export interface BulkJobDefinition<Context, Result = unknown> {
  readonly id: string
  readonly safety: BulkJobSafety
  run(context: Context): Promise<Result>
}

/** 声明任务；上限必须是正整数，在模块加载时即失败，避免误配进入生产 */
export function defineBulkJob<Context, Result>(
  definition: BulkJobDefinition<Context, Result>,
): BulkJobDefinition<Context, Result> {
  const { safety } = definition
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(definition.id))
    throw new Error(`Invalid bulk job id: ${definition.id}`)
  if (safety.kind === 'none') {
    if (!safety.reason.trim()) throw new Error(`Bulk job ${definition.id} needs a reason`)
  } else if (!Number.isSafeInteger(safety.cap) || safety.cap < 1) {
    throw new Error(`Bulk job ${definition.id} needs a positive integer cap`)
  } else if (!safety.order.trim() || !safety.timeGuard.trim() || !safety.capUnit.trim()) {
    throw new Error(`Bulk job ${definition.id} needs order and time guard descriptions`)
  }
  return definition
}

export interface BulkJobCutoff {
  /** 本轮删除截止时间：时间列不晚于它的行才会被处理 */
  readonly at: Date
  /** 截止时间距基准时间至少应有的保留期；按到期时间（expires_at）筛选的任务为 0 */
  readonly minRetentionMs: number
}

export type BulkJobTimeVerdict =
  | { readonly ok: true; readonly now: Date }
  | { readonly ok: false; readonly reason: Exclude<BulkJobGuardReason, 'rows-out-of-range'> }

const valid = (date: Date | undefined): date is Date =>
  date instanceof Date && Number.isFinite(date.getTime())

/**
 * 整轮时间检查：以数据库时钟为基准，应用时钟只作对照。截止时间无效、早于下限、晚于基准，
 * 或换算出的保留期低于最小保留期时本轮不执行。秒被当成毫秒会落在 1970 年附近而被下限拦截；
 * 毫秒被当成秒会落在极远的未来而被「晚于基准」拦截。
 */
export function checkBulkJobTime(input: {
  readonly appNow: Date
  readonly dbNow: Date
  readonly cutoffs?: readonly BulkJobCutoff[]
}): BulkJobTimeVerdict {
  const { appNow, dbNow } = input
  if (!valid(dbNow) || !valid(appNow)) return { ok: false, reason: 'invalid-cutoff' }
  if (dbNow.getTime() < BULK_JOB_TIME_FLOOR.getTime())
    return { ok: false, reason: 'cutoff-before-floor' }
  if (Math.abs(appNow.getTime() - dbNow.getTime()) > BULK_JOB_MAX_CLOCK_SKEW_MS)
    return { ok: false, reason: 'clock-skew' }
  for (const cutoff of input.cutoffs ?? []) {
    if (!valid(cutoff.at) || !Number.isFinite(cutoff.minRetentionMs) || cutoff.minRetentionMs < 0)
      return { ok: false, reason: 'invalid-cutoff' }
    if (cutoff.at.getTime() < BULK_JOB_TIME_FLOOR.getTime())
      return { ok: false, reason: 'cutoff-before-floor' }
    if (cutoff.at.getTime() > dbNow.getTime()) return { ok: false, reason: 'cutoff-in-future' }
    if (dbNow.getTime() - cutoff.at.getTime() < cutoff.minRetentionMs)
      return { ok: false, reason: 'retention-too-short' }
  }
  return { ok: true, now: dbNow }
}

/** 截止时间 = 基准时间 − 保留期；保留期非有限数时得到无效日期，由 checkBulkJobTime 拦截 */
export function cutoffBefore(now: Date, retentionMs: number) {
  return new Date(now.getTime() - retentionMs)
}

/** 告警去重键中的 UTC 日期 */
export function utcDay(date: Date) {
  return date.toISOString().slice(0, 10)
}

/** 汇总一轮结果；区间外行数大于 0 时追加告警，但不影响本轮处理正常行 */
export function bulkJobOutcome(input: {
  processed: number
  cap: number
  /** 多个上限（如空间数与对象数）时由任务自行判断 */
  capReached?: boolean
  tripped?: BulkJobTrip | readonly BulkJobTrip[] | undefined
  outOfRange?: number
}): BulkJobOutcome {
  const tripped: BulkJobTrip[] = input.tripped
    ? Array.isArray(input.tripped)
      ? [...(input.tripped as readonly BulkJobTrip[])]
      : [input.tripped as BulkJobTrip]
    : []
  if (input.outOfRange && input.outOfRange > 0)
    tripped.push({ reason: 'rows-out-of-range', count: input.outOfRange })
  return {
    processed: input.processed,
    capReached: input.capReached ?? input.processed >= input.cap,
    tripped,
  }
}

/** 整轮防护未通过时的结果：什么都没做 */
export function bulkJobSkipped(reason: BulkJobTrip['reason']): BulkJobOutcome {
  return { processed: 0, capReached: false, tripped: [{ reason }] }
}
