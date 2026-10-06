import { env } from 'cloudflare:workers'
import type { LanguageModelFactory } from '@saas/ai'
import { createAuth } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { getCreditBalance, grant } from '@saas/credits'
import { type AiPricingJson, aiModel, createDb, member as memberTable } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { newId } from '@saas/shared'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type ChatDeps,
  type ChatStopDeps,
  handleChatRequest,
  handleChatStopRequest,
} from '../src/features/ai/chat.ts'

// tasks.md 2.3：POST /api/ai/chat 的三种结算（正常完成、实际少于预扣、实际多于预扣），
// 以及未配置模型工厂时的 503、余额不足与他人对话的拒绝。模型为 AI SDK 的模拟模型。
// tasks.md 2.4、2.5：停止接口（同 isolate / 跨 isolate）、出错结算与用量检查点。

const APP_URL = 'http://localhost:3000'
const PASSWORD = 'correct-horse-battery-staple'
const EMAIL_DOMAIN = `${newId()}.web-ai-chat-test.example`
const OVERAGE = { maxRatio: 0.2, maxCredits: 50, dailyBudgetPerWorkspace: 200 }
/** 本次运行创建的模型 key 前缀，清理时按它删除 */
const MODEL_KEY_PREFIX = `chat-test-${newId()}-`

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const auth = createAuth(
  { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
  db,
  {
    config: defineTemplateConfig({
      app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: async () => {},
  },
)

const authPost = (path: string, body: unknown) =>
  auth.handler(
    new Request(`${APP_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_URL },
      body: JSON.stringify(body),
    }),
  )

/** 注册并登录；注册会创建个人空间（id 与用户 id 相同） */
async function member(name: string, credits = 0) {
  const email = `${name}-${newId()}@${EMAIL_DOMAIN}`
  const signUp = await authPost('/sign-up/email', { email, password: PASSWORD, name })
  expect(signUp.status).toBe(200)
  const { user } = (await signUp.json()) as { user: { id: string } }
  const res = await authPost('/sign-in/email', { email, password: PASSWORD })
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .join('; ')
  const [ws] = await sql<{ id: string; slug: string }[]>`
    select id, slug from organization where id = ${user.id}`
  if (!ws) throw new Error('personal workspace missing')
  if (credits > 0)
    await grant(db, { workspaceId: ws.id, source: 'admin', sourceRef: newId(), amount: credits })
  return { userId: user.id, workspaceId: ws.id, slug: ws.slug, cookie }
}

async function textModel(pricing: AiPricingJson, maxOutputTokens?: number) {
  const id = newId()
  await db.insert(aiModel).values({
    id,
    key: `${MODEL_KEY_PREFIX}${id}`,
    kind: 'text',
    provider: 'mock',
    providerModelId: 'mock-model',
    pricing,
    paramsSchema: maxOutputTokens ? { 'x-text': { maxOutputTokens } } : null,
  })
  return id
}

/** 按块输出 `text`，结束时回报 usage（服务商通常只在流结束时返回 usage） */
function mockModel(text: string, usage: { input: number; output: number }) {
  const chunks = text.match(/.{1,8}/gs) ?? []
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start' as const, id: 't1' },
          ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: {
              inputTokens: {
                total: usage.input,
                noCache: usage.input,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  })
}

function chatDeps(options: { factory?: LanguageModelFactory; mock?: MockLanguageModelV4 }) {
  const background: Promise<unknown>[] = []
  const deps: ChatDeps = {
    db,
    auth,
    env: {},
    rateLimiter: { limit: async () => ({ success: true }) },
    waitUntil: (promise) => background.push(promise),
    entitlements: async () => ({
      key: 'test',
      sort: 0,
      features: { ...DEFAULT_FREE_FEATURES, models: ['*'] },
    }),
    overage: OVERAGE,
    ...(options.mock
      ? { languageModelFactory: () => options.mock as MockLanguageModelV4 }
      : options.factory
        ? { languageModelFactory: options.factory }
        : {}),
  }
  return { deps, background }
}

/** 发起请求但不读取响应，用于在流式过程中观察检查点或调用停止接口 */
async function begin(
  who: { slug: string; cookie: string },
  body: { modelId: string; text: string; conversationId?: string },
  options: { factory?: LanguageModelFactory; mock?: MockLanguageModelV4 } = {},
) {
  const { deps, background } = chatDeps(options)
  const response = await handleChatRequest(
    new Request(`${APP_URL}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: who.cookie },
      body: JSON.stringify({
        slug: who.slug,
        modelId: body.modelId,
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        message: { role: 'user', parts: [{ type: 'text', text: body.text }] },
      }),
    }),
    deps,
  )
  return { response, settled: () => Promise.all(background) }
}

/** 模拟模型以流错误结束（中止、服务商断开）时，响应流随之出错；只取已收到的部分 */
async function bodyText(response: Response) {
  if (!response.body) return ''
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    return text
  }
}

async function send(
  who: { slug: string; cookie: string },
  body: { modelId: string; text: string; conversationId?: string },
  options: { factory?: LanguageModelFactory; mock?: MockLanguageModelV4 } = {},
) {
  const { response, settled } = await begin(who, body, options)
  const stream = await bodyText(response)
  await settled()
  return { response, stream }
}

/** UI message 流中各 text-delta 拼接出的回复 */
function streamedText(stream: string) {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; delta?: string })
    .flatMap((chunk) => (chunk.type === 'text-delta' && chunk.delta ? [chunk.delta] : []))
    .join('')
}

async function assistantMessage(conversationId: string) {
  const [row] = await sql<
    {
      id: string
      status: string
      parts: { type: string; text: string }[]
      credits: number
      input_tokens: number
      output_tokens: number
      pricing: AiPricingJson
      hold_id: string
      usage_checkpoint: { inputTokens: number; outputTokens: number; at: string } | null
    }[]
  >`select * from ai_message where conversation_id = ${conversationId} and role = 'assistant'
    order by id desc limit 1`
  if (!row) throw new Error('assistant message missing')
  const [reservation] = await sql<
    {
      status: string
      amount: number
      captured_amount: number
      overage_absorbed: number
      expires_at: Date | null
    }[]
  >`select * from credit_hold where id = ${row.hold_id}`
  return { message: row, hold: reservation }
}

afterAll(async () => {
  const ids = sql`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  await sql`delete from ai_message where workspace_id in (${ids})`
  await sql`delete from ai_conversation where workspace_id in (${ids})`
  await sql`delete from credit_hold_allocation where hold_id in
    (select id from credit_hold where workspace_id in (${ids}))`
  await sql`delete from credit_ledger where workspace_id in (${ids})`
  await sql`delete from credit_hold where workspace_id in (${ids})`
  await sql`delete from credit_grant where workspace_id in (${ids})`
  await sql`delete from credit_debt where workspace_id in (${ids})`
  await sql`delete from session where user_id in (${ids})`
  await sql`delete from account where user_id in (${ids})`
  await sql`delete from member where user_id in (${ids})`
  await sql`delete from organization where id in (${ids})`
  await sql`delete from "user" where id in (${ids})`
  await sql`delete from ai_model where key like ${`${MODEL_KEY_PREFIX}%`}`
})

describe('POST /api/ai/chat 结算', () => {
  it('正常完成（按次）：流式返回完整回复，扣除固定积分，消息标记 completed', async () => {
    const me = await member('per-call', 100)
    const modelId = await textModel({
      mode: 'per_call',
      credits: 3,
      limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
    })
    const mock = mockModel('Hello from the mock model!', { input: 20, output: 7 })
    const { response, stream } = await send(me, { modelId, text: '你好' }, { mock })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const conversationId = response.headers.get('x-conversation-id') as string
    expect(streamedText(stream)).toBe('Hello from the mock model!')
    expect(stream).toContain(conversationId)
    expect(mock.doStreamCalls[0]?.maxOutputTokens).toBe(500)

    const { message, hold } = await assistantMessage(conversationId)
    expect(message).toMatchObject({
      status: 'completed',
      parts: [{ type: 'text', text: 'Hello from the mock model!' }],
      credits: 3,
      input_tokens: 20,
      output_tokens: 7,
      pricing: { mode: 'per_call', credits: 3 },
    })
    expect(hold).toMatchObject({ status: 'captured', amount: 3, captured_amount: 3 })
    expect((await getCreditBalance(db, me.workspaceId)).available).toBe(97)
    const ledger = await sql<{ type: string; delta: number; ref_id: string }[]>`
      select type, delta, ref_id from credit_ledger
      where workspace_id = ${me.workspaceId} and type = 'consume'`
    expect(ledger).toEqual([{ type: 'consume', delta: -3, ref_id: message.id }])
  })

  it('实际少于预扣（按 token）：预扣 50、实际 12 → 扣除 12、退回 38', async () => {
    const me = await member('token-less', 1000)
    // 预扣 = ceil((估算输入 × 1 + 4900 × 10) / 1000) = 50
    const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 4900)
    // 实际 = (200 × 1 + 1180 × 10) / 1000 = 12
    const mock = mockModel('short answer', { input: 200, output: 1180 })
    const { response } = await send(me, { modelId, text: 'hi' }, { mock })
    expect(response.status).toBe(200)

    const { message, hold } = await assistantMessage(
      response.headers.get('x-conversation-id') as string,
    )
    expect(hold).toMatchObject({ status: 'captured', amount: 50, captured_amount: 12 })
    expect(message).toMatchObject({ status: 'completed', credits: 12 })
    expect(mock.doStreamCalls[0]?.maxOutputTokens).toBe(4900)
    expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({
      available: 988,
      held: 0,
      debt: 0,
    })
  })

  it('实际多于预扣（按 token）：回复完整，超出部分按超额规则平台承担 + 从余额补扣', async () => {
    const me = await member('token-more', 1000)
    // 预扣 = ceil((估算输入 × 10 + 1000 × 10) / 1000) = 11
    const modelId = await textModel({ mode: 'token', inputPer1k: 10, outputPer1k: 10 }, 1000)
    // 输入估算偏低：实际 = (400 × 10 + 1000 × 10) / 1000 = 14，超出 3
    const reply = 'A complete reply that must not be truncated.'
    const mock = mockModel(reply, { input: 400, output: 1000 })
    const { response, stream } = await send(me, { modelId, text: 'hi' }, { mock })
    expect(response.status).toBe(200)
    expect(streamedText(stream)).toBe(reply)

    const { message, hold } = await assistantMessage(
      response.headers.get('x-conversation-id') as string,
    )
    // 平台最多承担 floor(11 × 20%) = 2，其余 1 从余额补扣
    expect(hold).toMatchObject({
      status: 'captured',
      amount: 11,
      captured_amount: 11,
      overage_absorbed: 2,
    })
    expect(message).toMatchObject({
      status: 'completed',
      parts: [{ type: 'text', text: reply }],
      credits: 12,
    })
    expect((await getCreditBalance(db, me.workspaceId)).available).toBe(988)
  })
})

describe('POST /api/ai/chat 调用前检查', () => {
  it('未配置模型工厂时返回 503 AI_PROVIDER_NOT_CONFIGURED，不预扣', async () => {
    const me = await member('no-provider', 100)
    const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 1 })
    const { response, stream } = await send(me, { modelId, text: 'hi' })
    expect(response.status).toBe(503)
    expect(JSON.parse(stream)).toMatchObject({ error: { code: 'AI_PROVIDER_NOT_CONFIGURED' } })
    const holds = await sql`select 1 from credit_hold where workspace_id = ${me.workspaceId}`
    expect(holds).toHaveLength(0)
  })

  it('余额不足以支付最小输出时返回 402 INSUFFICIENT_CREDITS，模型未被调用', async () => {
    // 每 token 1 积分：余额 1 连估算的输入都不够，更谈不上最小输出
    const me = await member('poor', 1)
    const modelId = await textModel({ mode: 'token', inputPer1k: 1000, outputPer1k: 1000 })
    const mock = mockModel('never', { input: 1, output: 1 })
    const { response, stream } = await send(me, { modelId, text: 'hi' }, { mock })
    expect(response.status).toBe(402)
    expect(JSON.parse(stream)).toEqual({
      error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits' },
    })
    expect(mock.doStreamCalls).toHaveLength(0)
  })

  it('对话只对创建者可见：同一空间的其他成员带对话 ID 请求返回 404', async () => {
    const owner = await member('owner', 100)
    const modelId = await textModel({
      mode: 'per_call',
      credits: 1,
      limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
    })
    const first = await send(
      owner,
      { modelId, text: 'first' },
      { mock: mockModel('one', { input: 5, output: 1 }) },
    )
    const conversationId = first.response.headers.get('x-conversation-id') as string

    // 同一对话继续发送：历史随请求发给模型
    const mock = mockModel('two', { input: 9, output: 1 })
    const second = await send(owner, { modelId, text: 'second', conversationId }, { mock })
    expect(second.response.status).toBe(200)
    expect(JSON.stringify(mock.doStreamCalls[0]?.prompt)).toContain('first')

    const other = await member('other')
    await db.insert(memberTable).values({
      id: newId(),
      organizationId: owner.workspaceId,
      userId: other.userId,
      role: 'admin',
    })
    const denied = await send(
      { slug: owner.slug, cookie: other.cookie },
      { modelId, text: 'peek', conversationId },
      { mock: mockModel('x', { input: 1, output: 1 }) },
    )
    expect(denied.response.status).toBe(404)
  })
})

const USAGE_FINISH = (input: number, output: number) => ({
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  },
})

/**
 * 长流模拟：每块 8 个字符（估算 8 个输出 token），在 `gates` 指定的块之前暂停，直到测试放行；
 * 中止时像服务商断开连接一样以错误结束。`reached(i)` 在流停在第 i 块的闸门前时完成。
 */
function gatedModel(options: {
  chunks: number
  gates: number[]
  usage?: { input: number; output: number }
  /** 在第 n 块之后以服务商错误结束 */
  failAfter?: number
}) {
  const gates = new Map(
    options.gates.map((index) => {
      let open!: () => void
      let reached!: () => void
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      const arrived = new Promise<void>((resolve) => {
        reached = resolve
      })
      return [index, { open, opened, reached, arrived }] as const
    }),
  )
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          const aborted = new Promise<void>((resolve) =>
            abortSignal?.addEventListener('abort', () => resolve()),
          )
          controller.enqueue({ type: 'text-start', id: 't1' })
          for (let i = 0; i < options.chunks; i++) {
            const gate = gates.get(i)
            if (gate) {
              gate.reached()
              await Promise.race([gate.opened, aborted])
            }
            await new Promise((resolve) => setTimeout(resolve, 1))
            if (abortSignal?.aborted) return controller.error(abortSignal.reason)
            if (options.failAfter === i) return controller.error(new Error('provider down'))
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'abcdefgh' })
          }
          controller.enqueue({ type: 'text-end', id: 't1' })
          const usage = options.usage ?? { input: 1, output: options.chunks * 8 }
          controller.enqueue(USAGE_FINISH(usage.input, usage.output))
          controller.close()
        },
      }),
    }),
  })
  return {
    model,
    reached: (index: number) => gates.get(index)?.arrived as Promise<void>,
    open: (index: number) => gates.get(index)?.open(),
  }
}

/** 轮询直到条件成立 */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function stop(
  who: { slug: string; cookie: string },
  messageId: string,
  deps: Partial<ChatStopDeps> = {},
) {
  const response = await handleChatStopRequest(
    new Request(`${APP_URL}/api/ai/chat/${messageId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: who.cookie },
      body: JSON.stringify({ slug: who.slug }),
    }),
    messageId,
    { db, auth, overage: OVERAGE, ...deps },
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function consumeLedger(workspaceId: string) {
  return sql<{ delta: number }[]>`
    select delta from credit_ledger where workspace_id = ${workspaceId} and type = 'consume'`
}

describe('用量检查点（tasks 2.5）', () => {
  it('长流每 200 个输出 token 写入检查点与已生成内容；正常完成时以最终 usage 结算', async () => {
    const me = await member('checkpoint', 1000)
    const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 4900)
    const gated = gatedModel({ chunks: 60, gates: [30, 55], usage: { input: 300, output: 999 } })
    const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
    const conversationId = response.headers.get('x-conversation-id') as string
    const read = async () => (await assistantMessage(conversationId)).message

    await gated.reached(30)
    const first = await until(read, (m) => m.usage_checkpoint !== null)
    expect(first).toMatchObject({
      status: 'streaming',
      usage_checkpoint: { inputTokens: 10, outputTokens: 200 },
      parts: [{ type: 'text', text: 'abcdefgh'.repeat(25) }],
    })

    gated.open(30)
    await gated.reached(55)
    const second = await until(read, (m) => m.usage_checkpoint?.outputTokens === 400)
    expect(second.parts).toEqual([{ type: 'text', text: 'abcdefgh'.repeat(50) }])
    expect(Date.parse(second.usage_checkpoint?.at ?? '')).toBeGreaterThanOrEqual(
      Date.parse(first.usage_checkpoint?.at ?? ''),
    )

    gated.open(55)
    expect(streamedText(await bodyText(response))).toBe('abcdefgh'.repeat(60))
    await settled()
    // 最终 usage：ceil((300 × 1 + 999 × 10) / 1000) = 11，与检查点（400 token）无关
    const { message, hold } = await assistantMessage(conversationId)
    expect(message).toMatchObject({
      status: 'completed',
      credits: 11,
      input_tokens: 300,
      output_tokens: 999,
      parts: [{ type: 'text', text: 'abcdefgh'.repeat(60) }],
    })
    expect(hold).toMatchObject({ status: 'captured', captured_amount: 11 })
    // 预扣带 10 分钟有效期，供兜底处理器回收
    const ttl = new Date(hold?.expires_at ?? 0).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(9 * 60_000)
    expect(ttl).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe('POST /api/ai/chat/:messageId/stop（tasks 2.4）', () => {
  it('按 token 停止（同 isolate）：中止生成，保留已生成部分并按已产生用量结算；再次停止幂等', async () => {
    const me = await member('stop-token', 1000)
    // 预扣 = ceil((10 × 10 + 1000 × 100) / 1000) = 101
    const modelId = await textModel({ mode: 'token', inputPer1k: 10, outputPer1k: 100 }, 1000)
    const gated = gatedModel({ chunks: 60, gates: [10] })
    const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
    const conversationId = response.headers.get('x-conversation-id') as string
    const messageId = (await assistantMessage(conversationId)).message.id
    await gated.reached(10)

    expect(await stop(me, messageId)).toEqual({ status: 200, body: { status: 'aborted' } })
    await bodyText(response)
    await settled()
    // 已生成 80 个字符 ≈ 80 输出 token：ceil((10 × 10 + 80 × 100) / 1000) = 9
    const { message, hold } = await assistantMessage(conversationId)
    expect(message).toMatchObject({
      status: 'aborted',
      parts: [{ type: 'text', text: 'abcdefgh'.repeat(10) }],
      input_tokens: 10,
      output_tokens: 80,
      credits: 9,
    })
    expect(hold).toMatchObject({ status: 'captured', amount: 101, captured_amount: 9 })
    expect((await getCreditBalance(db, me.workspaceId)).available).toBe(991)

    expect(await stop(me, messageId)).toEqual({ status: 200, body: { status: 'aborted' } })
    expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -9 }])
  })

  it('跨 isolate 停止（按次）：按已持久化的检查点结算并标记 aborted，原流随后中止且不重复结算', async () => {
    const me = await member('stop-remote', 100)
    const modelId = await textModel({
      mode: 'per_call',
      credits: 3,
      limits: { maxInputTokens: 4000, maxOutputTokens: 2000 },
    })
    const gated = gatedModel({ chunks: 120, gates: [30] })
    const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
    const conversationId = response.headers.get('x-conversation-id') as string
    const read = async () => (await assistantMessage(conversationId)).message
    await gated.reached(30)
    const { id: messageId } = await until(read, (m) => m.usage_checkpoint !== null)

    // 停止请求落在没有该流的 isolate
    expect(await stop(me, messageId, { activeChats: new Map() })).toEqual({
      status: 200,
      body: { status: 'aborted' },
    })
    const stopped = await assistantMessage(conversationId)
    expect(stopped.message).toMatchObject({
      status: 'aborted',
      parts: [{ type: 'text', text: 'abcdefgh'.repeat(25) }],
      credits: 3,
    })
    expect(stopped.hold).toMatchObject({ status: 'captured', captured_amount: 3 })

    // 原流继续：下一个检查点发现消息已结束即中止，结束时的结算被预扣状态闸门跳过
    gated.open(30)
    const streamed = streamedText(await bodyText(response))
    await settled()
    expect(streamed.length).toBeLessThan(120 * 8)
    expect(await read()).toMatchObject({
      status: 'aborted',
      parts: [{ type: 'text', text: 'abcdefgh'.repeat(25) }],
      credits: 3,
    })
    expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -3 }])
    expect((await getCreditBalance(db, me.workspaceId)).available).toBe(97)
  })

  it('按次在产生输出前停止：释放预扣', async () => {
    const me = await member('stop-empty', 100)
    const modelId = await textModel({
      mode: 'per_call',
      credits: 3,
      limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
    })
    const gated = gatedModel({ chunks: 10, gates: [0] })
    const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
    const conversationId = response.headers.get('x-conversation-id') as string
    await gated.reached(0)
    const { message } = await assistantMessage(conversationId)
    expect(await stop(me, message.id)).toEqual({ status: 200, body: { status: 'aborted' } })
    await bodyText(response)
    await settled()
    expect(await assistantMessage(conversationId)).toMatchObject({
      message: { status: 'aborted', parts: [], credits: 0 },
      hold: { status: 'released' },
    })
    expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('已完成的消息幂等返回 completed；他人消息或不存在返回 404', async () => {
    const owner = await member('stop-owner', 100)
    const modelId = await textModel({
      mode: 'per_call',
      credits: 1,
      limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
    })
    const { response } = await send(
      owner,
      { modelId, text: 'hi' },
      { mock: mockModel('done', { input: 5, output: 1 }) },
    )
    const { message } = await assistantMessage(response.headers.get('x-conversation-id') as string)
    expect(await stop(owner, message.id)).toEqual({ status: 200, body: { status: 'completed' } })

    const other = await member('stop-other')
    await db.insert(memberTable).values({
      id: newId(),
      organizationId: owner.workspaceId,
      userId: other.userId,
      role: 'admin',
    })
    const peek = await stop({ slug: owner.slug, cookie: other.cookie }, message.id)
    expect(peek).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } })
    expect((await stop(owner, newId())).status).toBe(404)
    expect((await stop(owner, 'not-a-uuid')).status).toBe(404)
  })
})

describe('出错结算（tasks 2.4）', () => {
  const failing = () =>
    new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('provider unavailable')
      },
    })

  it('按次且无输出即出错：预扣全额退回，回复标记 failed', async () => {
    const me = await member('error-per-call', 100)
    const modelId = await textModel({
      mode: 'per_call',
      credits: 3,
      limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
    })
    const { response } = await send(me, { modelId, text: 'hi' }, { mock: failing() })
    expect(
      await assistantMessage(response.headers.get('x-conversation-id') as string),
    ).toMatchObject({
      message: { status: 'failed', parts: [], credits: 0 },
      hold: { status: 'released' },
    })
    expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 100, held: 0 })
    expect(await consumeLedger(me.workspaceId)).toEqual([])
  })

  it('按 token 且无输出即出错：收最低费用（按估算输入，不低于 minCharge）', async () => {
    const me = await member('error-token', 100)
    const modelId = await textModel(
      { mode: 'token', inputPer1k: 1, outputPer1k: 10, minCharge: 2 },
      1000,
    )
    const { response } = await send(me, { modelId, text: 'hi' }, { mock: failing() })
    expect(
      await assistantMessage(response.headers.get('x-conversation-id') as string),
    ).toMatchObject({
      message: { status: 'failed', parts: [], credits: 2 },
      hold: { status: 'captured', captured_amount: 2 },
    })
  })

  it('按 token 输出中途出错：保留部分内容，按已生成内容估算的用量结算', async () => {
    const me = await member('error-partial', 1000)
    const modelId = await textModel({ mode: 'token', inputPer1k: 10, outputPer1k: 100 }, 1000)
    const gated = gatedModel({ chunks: 60, gates: [], failAfter: 5 })
    const { response } = await send(me, { modelId, text: 'hi' }, { mock: gated.model })
    // ceil((10 × 10 + 40 × 100) / 1000) = 5
    expect(
      await assistantMessage(response.headers.get('x-conversation-id') as string),
    ).toMatchObject({
      message: {
        status: 'failed',
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(5) }],
        output_tokens: 40,
        credits: 5,
      },
      hold: { status: 'captured', captured_amount: 5 },
    })
  })
})
