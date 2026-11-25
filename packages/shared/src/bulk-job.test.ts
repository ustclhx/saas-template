import { describe, expect, it } from 'vitest'
import {
  BULK_JOB_TIME_FLOOR,
  bulkJobOutcome,
  checkBulkJobTime,
  cutoffBefore,
  defineBulkJob,
  utcDay,
} from './bulk-job.ts'

const now = new Date('2026-11-25T08:00:00.000Z')
const DAY = 86_400_000
const space = { minRetentionMs: DAY }

describe('checkBulkJobTime', () => {
  it('正常截止时间通过，基准取数据库时钟', () => {
    const dbNow = new Date(now.getTime() + 60_000)
    expect(
      checkBulkJobTime({
        appNow: now,
        dbNow,
        cutoffs: [{ at: cutoffBefore(dbNow, 30 * DAY), ...space }],
      }),
    ).toEqual({ ok: true, now: dbNow })
  })

  it.each([
    ['0（纪元起点）', new Date(0), 'cutoff-before-floor'],
    ['负数', new Date(-1), 'cutoff-before-floor'],
    ['1970（秒被当成毫秒）', new Date(1_764_057_600), 'cutoff-before-floor'],
    ['下限前一毫秒', new Date(BULK_JOB_TIME_FLOOR.getTime() - 1), 'cutoff-before-floor'],
    ['未来（毫秒被当成秒）', new Date(1_764_057_600_000 * 1000), 'cutoff-in-future'],
    ['未来一分钟', new Date(now.getTime() + 60_000), 'cutoff-in-future'],
    ['无效日期', new Date(Number.NaN), 'invalid-cutoff'],
    ['保留期被设为 0', now, 'retention-too-short'],
    ['保留期低于下限', new Date(now.getTime() - DAY + 1), 'retention-too-short'],
  ])('截止时间为%s时不执行', (_, at, reason) => {
    expect(checkBulkJobTime({ appNow: now, dbNow: now, cutoffs: [{ at, ...space }] })).toEqual({
      ok: false,
      reason,
    })
  })

  it('应用与数据库时钟相差超过 5 分钟时不执行', () => {
    const dbNow = new Date(now.getTime() + 5 * 60_000 + 1)
    expect(checkBulkJobTime({ appNow: now, dbNow })).toEqual({ ok: false, reason: 'clock-skew' })
    expect(checkBulkJobTime({ appNow: dbNow, dbNow: now })).toEqual({
      ok: false,
      reason: 'clock-skew',
    })
    expect(checkBulkJobTime({ appNow: now, dbNow: new Date(now.getTime() + 5 * 60_000) }).ok).toBe(
      true,
    )
  })

  it('数据库时钟本身无效或早于下限时不执行', () => {
    expect(checkBulkJobTime({ appNow: now, dbNow: new Date(Number.NaN) }).ok).toBe(false)
    expect(checkBulkJobTime({ appNow: new Date(0), dbNow: new Date(0) })).toEqual({
      ok: false,
      reason: 'cutoff-before-floor',
    })
  })

  it('保留期为非有限数时截止时间无效', () => {
    expect(
      checkBulkJobTime({
        appNow: now,
        dbNow: now,
        cutoffs: [{ at: cutoffBefore(now, Number.NaN), ...space }],
      }),
    ).toEqual({ ok: false, reason: 'invalid-cutoff' })
  })
})

describe('defineBulkJob', () => {
  const run = async () => undefined
  const safety = { capUnit: '条', order: '到期时间升序', timeGuard: '下限与基准时间' }
  it.each([0, -1, 1.5, Number.NaN])('上限 %s 不是正整数时拒绝', (cap) => {
    expect(() =>
      defineBulkJob({ id: 'x', safety: { kind: 'delete', cap, ...safety }, run }),
    ).toThrow('positive integer cap')
  })
  it('不涉及删除的任务必须写明原因', () => {
    expect(() => defineBulkJob({ id: 'x', safety: { kind: 'none', reason: ' ' }, run })).toThrow()
    expect(defineBulkJob({ id: 'x', safety: { kind: 'none', reason: '只读' }, run }).id).toBe('x')
  })
})

describe('bulkJobOutcome', () => {
  it('达到上限与区间外行数分别记录', () => {
    expect(bulkJobOutcome({ processed: 20, cap: 20, outOfRange: 2 })).toEqual({
      processed: 20,
      capReached: true,
      tripped: [{ reason: 'rows-out-of-range', count: 2 }],
    })
    expect(bulkJobOutcome({ processed: 3, cap: 20 })).toEqual({
      processed: 3,
      capReached: false,
      tripped: [],
    })
  })
  it('UTC 日期用于告警去重', () => {
    expect(utcDay(new Date('2026-11-25T23:59:59.999Z'))).toBe('2026-11-25')
  })
})
