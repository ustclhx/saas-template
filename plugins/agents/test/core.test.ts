import { describe, expect, it } from 'vitest'
import { respondedApprovalIds } from '../src/core/approvals.ts'
import {
  checkOwner,
  IDENTITY_HEADERS,
  isConversationId,
  readIdentity,
  stripIdentityHeaders,
  withIdentity,
} from '../src/core/identity.ts'
import { errorCodeOf, turnLogFields } from '../src/core/log.ts'
import {
  addTurnUsage,
  EMPTY_TURN_USAGE,
  evictedCallUsage,
  interruptedTurnCredits,
  nextStepExceedsHold,
  outputCharsAfterUser,
  outputCharsForTurn,
  readTurnUsage,
  turnCredits,
  turnHoldAmount,
} from '../src/core/usage.ts'

const CONVERSATION = '01a20da3-b190-7607-a11a-34b738fc875f'
const identity = { userId: 'u1', workspaceId: 'w1', conversationId: CONVERSATION }

describe('身份头（3.1）', () => {
  it('剥离全部 x-saas-*（大小写不敏感），保留其他头', () => {
    const headers = stripIdentityHeaders(
      new Headers({ 'X-SAAS-USER-ID': 'evil', 'x-saas-anything': '1', cookie: 'a=b' }),
    )
    expect([...headers.keys()]).toEqual(['cookie'])
  })

  it('写入服务端身份并覆盖伪造值，方法与正文保持不变', async () => {
    const forged = new Request('https://app.test/agents/agent-conversation/x', {
      method: 'POST',
      headers: { [IDENTITY_HEADERS.userId]: 'evil', upgrade: 'websocket' },
      body: 'payload',
    })
    const request = withIdentity(forged, identity)
    expect(readIdentity(request.headers)).toEqual(identity)
    expect(request.method).toBe('POST')
    expect(request.headers.get('upgrade')).toBe('websocket')
    expect(await request.text()).toBe('payload')
  })

  it('实例名只接受小写 UUID', () => {
    expect(isConversationId(CONVERSATION)).toBe(true)
    expect(isConversationId(CONVERSATION.toUpperCase())).toBe(false)
    expect(isConversationId('get-messages')).toBe(false)
  })
})

describe('实例侧归属比对（3.2）', () => {
  it('首次记住归属，之后一致放行', () => {
    const first = checkOwner(undefined, identity, CONVERSATION)
    expect(first).toEqual({ ok: true, owner: { userId: 'u1', workspaceId: 'w1' }, first: true })
    expect(checkOwner({ userId: 'u1', workspaceId: 'w1' }, identity, CONVERSATION)).toMatchObject({
      ok: true,
      first: false,
    })
  })

  it('缺少身份头、对话不符、归属不符一律拒绝', () => {
    expect(checkOwner(undefined, null, CONVERSATION)).toEqual({
      ok: false,
      reason: 'missing_identity',
    })
    expect(checkOwner(undefined, identity, 'other')).toEqual({
      ok: false,
      reason: 'conversation_mismatch',
    })
    expect(checkOwner({ userId: 'u2', workspaceId: 'w1' }, identity, CONVERSATION)).toEqual({
      ok: false,
      reason: 'owner_mismatch',
    })
    expect(checkOwner({ userId: 'u1', workspaceId: 'w2' }, identity, CONVERSATION)).toEqual({
      ok: false,
      reason: 'owner_mismatch',
    })
  })
})

describe('轮次用量与积分（4.1 / 4.2）', () => {
  const token = { mode: 'token', inputPer1k: 10, outputPer1k: 10 } as const
  const perCall = {
    mode: 'per_call',
    credits: 3,
    limits: { maxInputTokens: 1000, maxOutputTokens: 100 },
  } as const

  it('预扣 = 单步 × 步数，按配置封顶与余额封顶', () => {
    expect(turnHoldAmount({ stepHold: 11, maxSteps: 8, balance: 1000 })).toBe(88)
    expect(turnHoldAmount({ stepHold: 11, maxSteps: 8, maxTurnCredits: 30, balance: 1000 })).toBe(
      30,
    )
    expect(turnHoldAmount({ stepHold: 11, maxSteps: 8, balance: 40 })).toBe(40)
  })

  it('按 token 整轮合计取整一次；按次每步收一次', () => {
    const usage = addTurnUsage(EMPTY_TURN_USAGE, { inputTokens: 200, outputTokens: 13, steps: 2 })
    expect(turnCredits(token, usage)).toBe(3)
    expect(turnCredits(perCall, usage)).toBe(6)
  })

  it('中断：失败全退释放；无输出失败免费次数内释放；停止按已记录用量', () => {
    const none = EMPTY_TURN_USAGE
    const some = addTurnUsage(none, { inputTokens: 100, outputTokens: 10, steps: 1 })
    expect(
      interruptedTurnCredits(token, some, { status: 'failed', failedReplyRefund: 'all' }),
    ).toBeUndefined()
    expect(interruptedTurnCredits(token, none, { status: 'failed' })).toBeUndefined()
    expect(
      interruptedTurnCredits(token, none, { status: 'failed', freeFailuresExhausted: true }),
    ).toBe(1)
    expect(interruptedTurnCredits(token, some, { status: 'stopped' })).toBe(2)
    expect(interruptedTurnCredits(perCall, none, { status: 'expired' })).toBeUndefined()
    expect(interruptedTurnCredits(perCall, some, { status: 'expired' })).toBe(3)
  })

  it('检查点 JSON 缺字段按 0 读取；可见输出只计最后一条用户消息之后', () => {
    expect(readTurnUsage(null)).toEqual(EMPTY_TURN_USAGE)
    expect(readTurnUsage({ inputTokens: 5, steps: 2, estimated: true })).toMatchObject({
      inputTokens: 5,
      steps: 2,
      estimated: true,
    })
    const messages = [
      { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'old reply' }] },
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: '你好' },
          { type: 'tool-current_time', input: {}, output: { now: 'long output not counted' } },
        ],
      },
    ]
    expect(outputCharsAfterUser(messages)).toBe(2 + 2)
  })
})

describe('预扣封顶与估算（B2 / B3）', () => {
  const token = { mode: 'token', inputPer1k: 10, outputPer1k: 10 } as const
  it('已用量加下一步估算超过预扣时停止', () => {
    const used = addTurnUsage(EMPTY_TURN_USAGE, { inputTokens: 300, outputTokens: 30, steps: 2 })
    const next = { pricing: token, used, nextInputTokens: 200, maxOutputTokens: 100 }
    // 330 + 300 = 630 token → 7 积分
    expect(nextStepExceedsHold({ ...next, holdAmount: 7 })).toBe(false)
    expect(nextStepExceedsHold({ ...next, holdAmount: 6 })).toBe(true)
  })

  it('被驱逐调用按模型的 tokensPerChar 估算输出', () => {
    expect(
      evictedCallUsage({
        inputTokens: 50,
        visibleChars: 30,
        checkpointChars: 10,
        tokensPerChar: 1.5,
      }),
    ).toEqual({ inputTokens: 50, outputTokens: 30, outputChars: 30, estimated: true })
  })

  it('旧轮的可见输出只计到下一条用户消息为止', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'abcd' }] },
      { id: 'u2', role: 'user', parts: [] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'xyz' }] },
    ]
    expect(outputCharsForTurn(messages, 'u1')).toBe(4)
    expect(outputCharsForTurn(messages, 'missing')).toBe(0)
  })
})

describe('确认续轮', () => {
  const pending = {
    id: 'a',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'need approval' },
      {
        type: 'tool-spike_write',
        toolCallId: 'c1',
        state: 'approval-requested',
        approval: { id: 'ap' },
      },
    ],
  }

  it('只取最后一条用户消息之后已回复确认的工具调用 id', () => {
    const responded = {
      ...pending,
      parts: [{ ...pending.parts[1], state: 'approval-responded' }],
    }
    const user = { id: 'u', role: 'user', parts: [] }
    expect(respondedApprovalIds([user, pending])).toEqual([])
    expect(respondedApprovalIds([user, responded])).toEqual(['c1'])
    expect(respondedApprovalIds([responded, user])).toEqual([])
  })
})

describe('每轮日志（4.5）', () => {
  it('只输出白名单字段，工具名去重并过滤非法值', () => {
    const fields = turnLogFields({
      ...identity,
      turnId: 't',
      status: 'completed',
      steps: 2,
      tools: ['current_time', 'current_time', 'bad name {"note":"secret"}'],
      durationMs: 5,
      credits: 3,
    })
    expect(fields).toEqual({
      turnId: 't',
      conversationId: CONVERSATION,
      workspaceId: 'w1',
      userId: 'u1',
      status: 'completed',
      steps: 2,
      tools: ['current_time'],
      durationMs: 5,
      credits: 3,
    })
  })

  it('错误只取 code 或类名，不取 message', () => {
    expect(errorCodeOf({ code: 'INSUFFICIENT_CREDITS', message: 'secret' })).toBe(
      'INSUFFICIENT_CREDITS',
    )
    expect(errorCodeOf(new TypeError('user text'))).toBe('TypeError')
    expect(errorCodeOf('raw string')).toBe('UNKNOWN')
  })
})
