import { describe, expect, it } from 'vitest'
import type { Pricing } from '../pricing.ts'
import { checkpointSchedule, interruptedCredits, messageText } from './settle.ts'

describe('checkpointSchedule（tasks 2.5）', () => {
  const clock = () => {
    let t = 0
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('每 200 个输出 token 到期一次', () => {
    const c = clock()
    const schedule = checkpointSchedule({ now: c.now })
    expect(schedule.due(199)).toBe(false)
    expect(schedule.due(200)).toBe(true)
    expect(schedule.due(399)).toBe(false)
    expect(schedule.due(400)).toBe(true)
  })

  it('每 5 秒到期一次，但没有新输出时不到期', () => {
    const c = clock()
    const schedule = checkpointSchedule({ now: c.now })
    c.advance(4_999)
    expect(schedule.due(10)).toBe(false)
    c.advance(1)
    expect(schedule.due(10)).toBe(true)
    c.advance(10_000)
    expect(schedule.due(10)).toBe(false)
    expect(schedule.due(11)).toBe(true)
  })

  it('先到者触发，并从触发时重新计时与计数', () => {
    const c = clock()
    const schedule = checkpointSchedule({ now: c.now })
    c.advance(1_000)
    expect(schedule.due(250)).toBe(true)
    c.advance(4_500)
    // 距上次 4.5 秒、新增 100 token：都未到
    expect(schedule.due(350)).toBe(false)
    c.advance(500)
    expect(schedule.due(360)).toBe(true)
  })
})

describe('interruptedCredits（tasks 2.4、2.6）', () => {
  const token: Pricing = { mode: 'token', inputPer1k: 1, outputPer1k: 10, minCharge: 2 }
  const perCall: Pricing = {
    mode: 'per_call',
    credits: 3,
    limits: { maxInputTokens: 1000, maxOutputTokens: 500 },
  }

  it('按 token：按已产生用量结算', () => {
    // (1000 × 1 + 1000 × 10) / 1000 = 11
    expect(
      interruptedCredits(token, { inputTokens: 1000, outputTokens: 1000, hasOutput: true }),
    ).toBe(11)
  })

  it('按 token：没有输出用量时收最低费用（按估算输入，不低于 minCharge）', () => {
    expect(interruptedCredits(token, { inputTokens: 100, outputTokens: 0, hasOutput: false })).toBe(
      2,
    )
    expect(
      interruptedCredits(token, { inputTokens: 5000, outputTokens: 0, hasOutput: false }),
    ).toBe(5)
  })

  it('按次（默认 any_output）：有输出全额，无输出释放', () => {
    const usage = { inputTokens: 10, outputTokens: 0 }
    expect(interruptedCredits(perCall, { ...usage, hasOutput: true })).toBe(3)
    expect(interruptedCredits(perCall, { ...usage, hasOutput: false })).toBeUndefined()
  })

  it('按次 chargeOn success：未完成一律释放', () => {
    expect(
      interruptedCredits(
        { ...perCall, chargeOn: 'success' },
        { inputTokens: 10, outputTokens: 10, hasOutput: true },
      ),
    ).toBeUndefined()
  })
})

it('messageText 只拼接文本 part', () => {
  expect(
    messageText([
      { type: 'text', text: 'a' },
      { type: 'image' },
      null,
      { type: 'text', text: 'b' },
    ]),
  ).toBe('ab')
})
