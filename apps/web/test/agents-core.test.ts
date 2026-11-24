import { env } from 'cloudflare:workers'
import { createAuth } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { getCreditBalance, grant } from '@saas/credits'
import {
  type AiPricingJson,
  aiAgentTurn,
  aiConversation,
  aiModel,
  createDb,
  scoped,
} from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { AppError, newId } from '@saas/shared'
import {
  type LanguageModel,
  parseJsonEventStream,
  readUIMessageStream,
  type ToolSet,
  tool,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from 'ai'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { IDENTITY_HEADERS } from '../../../plugins/agents/src/core/identity.ts'
import {
  beginTurn,
  type OpenTurn,
  type TurnServiceDeps,
} from '../../../plugins/agents/src/core/turn.ts'
import { turnCredits } from '../../../plugins/agents/src/core/usage.ts'
import { authorizeAgentRequest } from '../../../plugins/agents/src/worker/gate.ts'
import {
  type AgentTurnDeps,
  type OpenTurnStore,
  runAgentTurn,
} from '../../../plugins/agents/src/worker/runner.ts'
import { createSpikeModel } from '../../../plugins/agents/src/worker/spike-model.ts'
import templateConfig from '../../../template.config.ts'

// openspec add-ai-agents 3.1、4.1–4.3、4.5：前置处理的身份校验、轮次服务（调用前检查、预扣、复用）、
// 结算各分支与实例编排（多步工具、等待确认、停止、恢复去重）。模型为脚本化测试替身，不调用真实 LLM；
// Durable Object 适配层（agent.ts）只做转发，这里直接驱动与 SDK 无关的 runner。

const enabled = Boolean(templateConfig.plugins.agents)
const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const APP_URL = 'http://localhost:3000'
const PASSWORD = 'correct-horse-battery-staple'
const EMAIL_DOMAIN = `${newId()}.web-agents-test.example`
const MODEL_KEY_PREFIX = `agents-test-${newId()}-`
const OVERAGE = { maxRatio: 0.2, maxCredits: 50, dailyBudgetPerWorkspace: 200 }
/** 0.01 积分 / token：脚本化模型一步 100 输入 + 10 或 N 输出 */
const PRICING: AiPricingJson = { mode: 'token', inputPer1k: 10, outputPer1k: 10 }

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
  if (credits > 0)
    await grant(db, { workspaceId: user.id, source: 'admin', sourceRef: newId(), amount: credits })
  return { userId: user.id, workspaceId: user.id, cookie }
}

async function model(
  options: { supportsTools?: boolean; pricing?: AiPricingJson; maxOutputTokens?: number } = {},
) {
  const id = newId()
  const key = `${MODEL_KEY_PREFIX}${id}`
  await db.insert(aiModel).values({
    id,
    key,
    kind: 'text',
    provider: 'mock',
    providerModelId: 'spike-scripted',
    pricing: options.pricing ?? PRICING,
    supportsTools: options.supportsTools ?? true,
    paramsSchema: { 'x-text': { maxOutputTokens: options.maxOutputTokens ?? 1000 } },
  })
  return key
}

async function conversation(owner: { userId: string; workspaceId: string }, modelKey: string) {
  const id = newId()
  await scoped(db, owner.workspaceId).insert(aiConversation, {
    id,
    userId: owner.userId,
    modelKey,
    kind: 'agent',
    agentId: 'assistant',
    title: 'agent test',
  })
  return id
}

/** 与脚本化模型配套的测试工具：只读的 current_time 与需要确认的 spike_write（无真实副作用） */
const testTools: ToolSet = {
  current_time: tool({
    description: 'Current UTC time',
    inputSchema: z.object({}),
    execute: async () => ({ now: new Date().toISOString() }),
  }),
  spike_write: tool({
    description: 'A side-effecting example tool that requires user approval',
    inputSchema: z.object({ note: z.string() }),
    needsApproval: true,
    execute: async () => ({ saved: true }),
  }),
}

function memoryStore(): OpenTurnStore & { value: OpenTurn | undefined } {
  return {
    value: undefined,
    get() {
      return this.value
    },
    set(turn) {
      this.value = turn
    },
    clear() {
      this.value = undefined
    },
  }
}

function deps(
  overrides: Partial<AgentTurnDeps> & { model?: () => LanguageModel } = {},
): AgentTurnDeps {
  const { model: languageModel, ...rest } = overrides
  return {
    db,
    entitlements: async () => ({
      key: 'test',
      sort: 0,
      features: { ...DEFAULT_FREE_FEATURES, models: ['*'] },
    }),
    multiTenant: false,
    overage: OVERAGE,
    failedReplyRefund: 'no-visible-output',
    maxSteps: 8,
    freeFailures: { count: 3, windowSeconds: 3600 },
    languageModel: languageModel ?? (() => createSpikeModel({ chunks: 3, chunkDelayMs: 1 })),
    ...rest,
  }
}

const userMessage = (text: string): UIMessage => ({
  id: newId(),
  role: 'user',
  parts: [{ type: 'text', text }],
})

/** 读完 UI 消息流，返回最终的 assistant 消息（续轮时在已有消息上继续） */
async function readReply(response: Response, message?: UIMessage): Promise<UIMessage> {
  const chunks = parseJsonEventStream({
    stream: response.body as ReadableStream<Uint8Array>,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream<{ success: boolean; value?: UIMessageChunk }, UIMessageChunk>({
      transform(result, controller) {
        if (result.success && result.value) controller.enqueue(result.value)
      },
    }),
  )
  let last: UIMessage | undefined
  for await (const next of readUIMessageStream({
    stream: chunks,
    ...(message ? { message } : {}),
  }))
    last = next
  return last ?? (message as UIMessage)
}

async function turnRows(conversationId: string) {
  return sql<
    {
      id: string
      status: string
      credits_charged: number
      steps: number
      hold_id: string
      request_id: string
      tool_calls: { name: string; status: string }[]
    }[]
  >`select id, status, credits_charged, steps, hold_id, request_id, tool_calls
    from ai_agent_turn where conversation_id = ${conversationId} order by id`
}

async function holds(workspaceId: string) {
  return sql<{ status: string; amount: number; captured_amount: number | null }[]>`
    select status, amount, captured_amount from credit_hold
    where workspace_id = ${workspaceId} and ref_type = 'agent_turn' order by created_at`
}

async function consumed(workspaceId: string) {
  const [row] = await sql<{ total: number }[]>`
    select coalesce(-sum(delta), 0)::int as total from credit_ledger
    where workspace_id = ${workspaceId} and type = 'consume'`
  return row?.total ?? 0
}

afterAll(async () => {
  const ids = sql`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  await sql`delete from ai_agent_turn where workspace_id in (${ids})`
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

const route = (conversationId: string, init: RequestInit = {}) =>
  new Request(`${APP_URL}/agents/agent-conversation/${conversationId}`, init)

describe.skipIf(!enabled)('前置处理身份校验（3.1）', () => {
  it('未登录返回 401', async () => {
    const owner = await member('gate-anon')
    const id = await conversation(owner, await model())
    const result = await authorizeAgentRequest(route(id), id, { db, auth })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('他人（同空间成员）的对话与已退出空间返回 404，非 UUID 名称返回 404', async () => {
    const owner = await member('gate-owner')
    const other = await member('gate-other')
    await sql`insert into member (id, organization_id, user_id, role)
      values (${newId()}, ${owner.workspaceId}, ${other.userId}, 'member')`
    const id = await conversation(owner, await model())
    const asOther = await authorizeAgentRequest(
      route(id, { headers: { cookie: other.cookie } }),
      id,
      { db, auth },
    )
    expect((asOther as Response).status).toBe(404)
    const bogus = await authorizeAgentRequest(route('x'), 'not-a-uuid', { db, auth })
    expect((bogus as Response).status).toBe(404)

    // 对话创建者被移出空间后不能再连接
    const leaver = await member('gate-leaver')
    await sql`insert into member (id, organization_id, user_id, role)
      values (${newId()}, ${owner.workspaceId}, ${leaver.userId}, 'member')`
    const team = await conversation(
      { userId: leaver.userId, workspaceId: owner.workspaceId },
      await model(),
    )
    const before = await authorizeAgentRequest(
      route(team, { headers: { cookie: leaver.cookie } }),
      team,
      { db, auth },
    )
    expect(before).toBeInstanceOf(Request)
    await sql`delete from member where organization_id = ${owner.workspaceId}
      and user_id = ${leaver.userId}`
    const after = await authorizeAgentRequest(
      route(team, { headers: { cookie: leaver.cookie } }),
      team,
      { db, auth },
    )
    expect((after as Response).status).toBe(404)
  })

  it('丢弃客户端伪造的 x-saas-* 头，身份只取自站点会话', async () => {
    const owner = await member('gate-forge')
    const victim = await member('gate-victim')
    const id = await conversation(owner, await model())
    const result = await authorizeAgentRequest(
      route(id, {
        headers: {
          cookie: owner.cookie,
          [IDENTITY_HEADERS.userId]: victim.userId,
          'X-SAAS-WORKSPACE-ID': victim.workspaceId,
          'x-saas-role': 'admin',
        },
      }),
      id,
      { db, auth },
    )
    expect(result).toBeInstanceOf(Request)
    const headers = (result as Request).headers
    expect(headers.get(IDENTITY_HEADERS.userId)).toBe(owner.userId)
    expect(headers.get(IDENTITY_HEADERS.workspaceId)).toBe(owner.workspaceId)
    expect(headers.get(IDENTITY_HEADERS.conversationId)).toBe(id)
    expect(headers.get('x-saas-role')).toBeNull()
    expect(headers.get('cookie')).toBe(owner.cookie)
  })
})

describe.skipIf(!enabled)('每轮调用前检查（4.1）', () => {
  const begin = async (
    owner: { userId: string; workspaceId: string },
    conversationId: string,
    overrides: Partial<TurnServiceDeps> = {},
    requestId = newId(),
  ) =>
    beginTurn(
      { ...deps(), ...overrides },
      {
        identity: { ...owner, conversationId },
        requestId,
        userMessageId: requestId,
        systemFor: () => 'You are a test agent.',
        messages: [userMessage('hello')],
        visibleChars: 0,
      },
    )

  const rejects = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }

  it('各拒绝分支：成员资格、模型不支持工具、限流、欠费、余额不足；均不预扣', async () => {
    const owner = await member('check', 50)
    const intruder = await member('check-intruder', 50)
    await sql`insert into member (id, organization_id, user_id, role)
      values (${newId()}, ${owner.workspaceId}, ${intruder.userId}, 'member')`
    const id = await conversation(owner, await model())
    // 同空间的另一成员（实例记住的归属与之不符时已在实例侧 403，这里验证服务层的兜底）
    await rejects(begin({ ...intruder, workspaceId: owner.workspaceId }, id), 'NOT_FOUND')
    // 被移出空间后不再能开始新的一轮
    const own = await conversation(
      { userId: intruder.userId, workspaceId: owner.workspaceId },
      await model(),
    )
    await sql`delete from member where organization_id = ${owner.workspaceId}
      and user_id = ${intruder.userId}`
    await rejects(begin({ ...intruder, workspaceId: owner.workspaceId }, own), 'NOT_FOUND')
    // PG 中对话不存在或已归档（用户删除）：实例据此自清理
    await rejects(begin(owner, newId()), 'AGENT_CONVERSATION_GONE')
    const archived = await conversation(owner, await model())
    await sql`update ai_conversation set archived = true where id = ${archived}`
    await rejects(begin(owner, archived), 'AGENT_CONVERSATION_GONE')
    const gate = await authorizeAgentRequest(
      route(archived, { headers: { cookie: owner.cookie } }),
      archived,
      { db, auth },
    )
    expect((gate as Response).status).toBe(404)

    const noTools = await conversation(owner, await model({ supportsTools: false }))
    await rejects(begin(owner, noTools), 'MODEL_UNAVAILABLE')

    await rejects(
      begin(owner, id, { rateLimiter: { limit: async () => ({ success: false }) } }),
      'RATE_LIMITED',
    )

    const poor = await member('check-poor', 0)
    await rejects(begin(poor, await conversation(poor, await model())), 'INSUFFICIENT_CREDITS')

    const debtor = await member('check-debt', 50)
    await sql`insert into credit_debt (workspace_id, amount) values (${debtor.workspaceId}, 5)`
    await rejects(begin(debtor, await conversation(debtor, await model())), 'CREDIT_DEBT')

    for (const who of [owner, poor, debtor]) expect(await holds(who.workspaceId)).toEqual([])
  })

  it('预扣 = 单步预算 × maxSteps，按 maxTurnCredits 封顶；同一请求 id 不重复预扣', async () => {
    const owner = await member('hold', 1000)
    const id = await conversation(owner, await model())
    const requestId = newId()
    const first = await begin(owner, id, { maxTurnCredits: 7 }, requestId)
    expect(first.holdAmount).toBe(7)
    expect(first.reused).toBe(false)
    const again = await begin(owner, id, { maxTurnCredits: 7 }, requestId)
    expect(again.reused).toBe(true)
    expect(again.turnId).toBe(first.turnId)
    expect(await holds(owner.workspaceId)).toEqual([
      { status: 'held', amount: 7, captured_amount: 0 },
    ])
    // 每轮开始时更新对话的 updated_at（列表排序与保留期判断）
    const [row] = await sql<{ touched: boolean }[]>`
      select updated_at > created_at as touched from ai_conversation where id = ${id}`
    expect(row?.touched).toBe(true)

    const uncapped = await member('hold-uncapped', 1000)
    const second = await begin(uncapped, await conversation(uncapped, await model()))
    // 单步：输入估算 + 1000 输出 token，0.01 积分 / token，向上取整后 × 8 步
    expect(second.holdAmount % 8).toBe(0)
    expect(second.holdAmount).toBeGreaterThanOrEqual(8 * 10)
  })
})

async function start(
  owner: { userId: string; workspaceId: string },
  conversationId: string,
  messages: UIMessage[],
  options: {
    store?: ReturnType<typeof memoryStore>
    deps?: AgentTurnDeps
    requestId?: string
    abortSignal?: AbortSignal
    active?: Map<string, AbortController>
  } = {},
) {
  const store = options.store ?? memoryStore()
  const run = await runAgentTurn(options.deps ?? deps(), {
    identity: { ...owner, conversationId },
    requestId: options.requestId ?? newId(),
    messages,
    systemFor: () => 'You are a test agent.',
    abortSignal: options.abortSignal,
    store,
    tools: () => testTools,
  })
  return { run, store }
}

describe.skipIf(!enabled)('一轮的执行与结算（4.2、4.3、4.5）', () => {
  it('多步工具：工具调用与结果、最终回复；按 totalUsage 与定价快照结算，预扣释放', async () => {
    const owner = await member('multi', 100)
    const id = await conversation(owner, await model())
    const user = userMessage('please use a tool')
    const { run, store } = await start(owner, id, [user])
    const reply = await readReply(run.response)
    const outcome = await run.done
    expect(outcome.status).toBe('completed')
    expect(reply.parts.map((part) => part.type)).toEqual(
      expect.arrayContaining(['tool-current_time', 'text']),
    )
    // 两步：工具步 100/10，文本步 100/3 → 213 token × 0.01 = 2.13 → 3 积分
    expect(outcome.usage).toMatchObject({ inputTokens: 200, outputTokens: 13, steps: 2 })
    expect(outcome.credits).toBe(3)
    // 界面据此显示「本轮 N 步 · X 积分」
    expect(reply.metadata).toEqual({ turnId: run.turn.turnId })
    expect(turnCredits({ mode: 'token', inputPer1k: 10, outputPer1k: 10 }, outcome.usage)).toBe(3)
    const [turn] = await turnRows(id)
    expect(turn).toMatchObject({ status: 'completed', credits_charged: 3, steps: 2 })
    expect(turn?.tool_calls).toEqual([
      expect.objectContaining({ name: 'current_time', status: 'completed' }),
    ])
    const [reservation] = await holds(owner.workspaceId)
    expect(reservation?.status).toBe('captured')
    expect(await consumed(owner.workspaceId)).toBe(3)
    expect((await getCreditBalance(db, owner.workspaceId)).available).toBe(97)
    expect(store.value).toBeUndefined()
  })

  it('等待确认期间不结算；批准后的续轮复用同一轮与预扣，只结算一次', async () => {
    const owner = await member('approve', 100)
    const id = await conversation(owner, await model())
    const user = userMessage('approve this write')
    const store = memoryStore()
    const first = await start(owner, id, [user], { store })
    const pending = await readReply(first.run.response)
    expect((await first.run.done).status).toBe('awaiting_approval')
    const toolPart = pending.parts.find((part) => part.type === 'tool-spike_write') as {
      state: string
      approval: { id: string }
    }
    expect(toolPart.state).toBe('approval-requested')
    expect(store.value?.turnId).toBe(first.run.turn.turnId)
    expect(store.value?.inFlightInputTokens).toBeUndefined()
    expect((await holds(owner.workspaceId))[0]?.status).toBe('held')
    expect((await turnRows(id))[0]?.status).toBe('running')

    // 用户批准：SDK 以新的 requestId 续轮，最后一条用户消息不变
    const approved: UIMessage = {
      ...pending,
      parts: pending.parts.map((part) =>
        part.type === 'tool-spike_write'
          ? ({
              ...part,
              state: 'approval-responded',
              approval: { id: toolPart.approval.id, approved: true },
            } as UIMessage['parts'][number])
          : part,
      ),
    }
    const second = await start(owner, id, [user, approved], { store })
    expect(second.run.turn.reused).toBe(true)
    expect(second.run.turn.turnId).toBe(first.run.turn.turnId)
    await readReply(second.run.response, approved)
    const outcome = await second.run.done
    expect(outcome.status).toBe('completed')
    // 第 1 步（请求确认）100/10 + 续轮文本步 100/3 = 213 token → 3 积分
    expect(outcome.usage).toMatchObject({ inputTokens: 200, outputTokens: 13, steps: 2 })
    const rows = await turnRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'completed', credits_charged: 3 })
    expect(await holds(owner.workspaceId)).toHaveLength(1)
    expect(await consumed(owner.workspaceId)).toBe(3)
  })

  it('实例被驱逐后恢复：续轮复用开放轮次，补记被驱逐调用的估算用量，只有一次预扣与结算', async () => {
    const owner = await member('recover', 100)
    const id = await conversation(owner, await model())
    const user = userMessage('tell me something')
    const store = memoryStore()
    // 首轮：模型输出几块后挂起，且没有人读取响应——模拟流式进行中实例被驱逐（进程消失，来不及结算）
    const hanging = (): LanguageModel => ({
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'hanging',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: 't' })
            controller.enqueue({ type: 'text-delta', id: 't', delta: 'chunk0 ' })
          },
        }),
      }),
    })
    const first = await start(owner, id, [user], { store, deps: deps({ model: hanging }) })
    expect(store.value?.inFlightInputTokens).toBeGreaterThan(0)
    expect(store.value?.turnId).toBe(first.run.turn.turnId)
    // 驱逐前已持久化的部分输出（SDK 恢复时保留在 assistant 消息中）
    const partial: UIMessage = {
      id: newId(),
      role: 'assistant',
      parts: [{ type: 'text', text: 'chunk0 chunk1 chunk2 ' }],
    }

    // 恢复：新的 requestId（retry 类恢复 continuation=false），最后一条用户消息不变
    const resumed = await start(owner, id, [user, partial], { store })
    expect(resumed.run.turn.reused).toBe(true)
    expect(resumed.run.turn.turnId).toBe(first.run.turn.turnId)
    // 被驱逐调用：输入按调用前估算，输出按已可见的 21 个字符
    expect(resumed.run.turn.usage.estimated).toBe(true)
    expect(resumed.run.turn.usage.outputTokens).toBe(21)
    await readReply(resumed.run.response, partial)
    const outcome = await resumed.run.done
    expect(outcome.status).toBe('completed')
    expect(await turnRows(id)).toHaveLength(1)
    const reservations = await holds(owner.workspaceId)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('captured')
    // 含估算：以预扣额封顶
    expect(reservations[0]?.captured_amount).toBeLessThanOrEqual(reservations[0]?.amount ?? 0)
  })

  it('续轮开始时超过预扣封顶：按检查点结算并拒绝继续，不再调用模型', async () => {
    const owner = await member('cap', 100)
    const id = await conversation(owner, await model())
    const user = userMessage('approve something')
    const store = memoryStore()
    const capped = deps({ maxTurnCredits: 2 })
    const first = await start(owner, id, [user], { store, deps: capped })
    const pending = await readReply(first.run.response)
    expect((await first.run.done).status).toBe('awaiting_approval')
    // 等待期间再记一笔大用量（例如被驱逐调用的估算），使已记录消耗超过封顶
    await sql`update ai_agent_turn set usage_checkpoint = usage_checkpoint
      || '{"inputTokens": 5000}'::jsonb where id = ${first.run.turn.turnId}`
    const calls = vi.fn()
    const error = await start(owner, id, [user, pending], {
      store,
      deps: { ...capped, languageModel: () => (calls(), createSpikeModel()) },
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as AppError).code).toBe('AGENT_TURN_LIMIT')
    expect(calls).not.toHaveBeenCalled()
    expect(store.value).toBeUndefined()
    const [turn] = await turnRows(id)
    expect(turn).toMatchObject({ status: 'stopped', credits_charged: 2 })
  })

  it('中途停止：保留已输出内容，按已记录用量与已流出字符结算（以预扣封顶）', async () => {
    const owner = await member('stop', 100)
    const id = await conversation(owner, await model())
    const controller = new AbortController()
    const { run } = await start(owner, id, [userMessage('long answer please')], {
      abortSignal: controller.signal,
      // 模型开始输出后再停止，避免机器繁忙时停止早于第一块输出
      deps: deps({
        model: () =>
          createSpikeModel({
            chunks: 200,
            chunkDelayMs: 10,
            onCall: () => setTimeout(() => controller.abort('stop'), 150),
          }),
      }),
    })
    await readReply(run.response).catch(() => undefined)
    const outcome = await run.done
    expect(outcome.status).toBe('stopped')
    expect(outcome.usage.estimated).toBe(true)
    expect(outcome.usage.outputTokens).toBeGreaterThan(0)
    const [turn] = await turnRows(id)
    expect(turn?.status).toBe('stopped')
    expect(turn?.credits_charged).toBe(outcome.credits)
    expect(await consumed(owner.workspaceId)).toBe(outcome.credits)
  })

  it('无可见输出的失败：免费次数内释放预扣，用完后按已记录用量收费', async () => {
    const owner = await member('fail', 100)
    const failing = (): LanguageModel => ({
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'failing',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () => Promise.reject(new AppError('UPSTREAM_DOWN', 'boom', { status: 502 })),
    })
    const failDeps = deps({ model: failing, freeFailures: { count: 1, windowSeconds: 3600 } })
    const first = await start(owner, await conversation(owner, await model()), [userMessage('x')], {
      deps: failDeps,
    })
    await readReply(first.run.response).catch(() => undefined)
    expect(await first.run.done).toMatchObject({ status: 'failed', credits: 0 })
    expect((await holds(owner.workspaceId))[0]?.status).toBe('released')

    const second = await start(
      owner,
      await conversation(owner, await model()),
      [userMessage('y')],
      {
        deps: failDeps,
      },
    )
    await readReply(second.run.response).catch(() => undefined)
    const outcome = await second.run.done
    expect(outcome.status).toBe('failed')
    // 免费次数用完：没有用量时按最低收费
    expect(outcome.credits).toBe(1)
  })

  it('结束日志只含 id、步数、工具名、耗时与积分，不含消息与工具参数', async () => {
    const owner = await member('log', 100)
    const id = await conversation(owner, await model())
    const lines: string[] = []
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        lines.push(String(line))
      }),
    )
    try {
      const { run } = await start(owner, id, [userMessage('SECRET-PAYLOAD use a tool')])
      await readReply(run.response)
      await run.done
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const end = lines.find((line) => line.includes('"agents.turn.end"'))
    expect(end).toBeDefined()
    expect(JSON.parse(end as string)).toMatchObject({
      status: 'completed',
      steps: 2,
      tools: ['current_time'],
      credits: 3,
    })
    expect(lines.join('\n')).not.toContain('SECRET-PAYLOAD')
    expect(lines.join('\n')).not.toContain('chunk0')
  })
})

describe.skipIf(!enabled)('审阅修复（B1–B5）', () => {
  /** 每次调用都请求 current_time 的模型：没有封顶时会一直调用到 maxSteps */
  const looping = (): LanguageModel => ({
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'looping',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('unused')),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({
            type: 'tool-call',
            toolCallId: `call-${newId()}`,
            toolName: 'current_time',
            input: '{}',
          })
          controller.enqueue({
            type: 'finish',
            usage: {
              inputTokens: {
                total: 100,
                noCache: 100,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 10, text: 10, reasoning: undefined },
            },
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          })
          controller.close()
        },
      }),
    }),
  })
  /** 输出一块后挂起、无人读取：模拟流式中的调用 */
  const hanging = (): LanguageModel => ({
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'hanging',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('unused')),
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 't' })
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'partial ' })
          // 与真实服务商一致：调用前或调用中被中止都结束流
          if (abortSignal?.aborted) controller.error(abortSignal.reason)
          else abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason))
        },
      }),
    }),
  })

  it('B1：新消息取代仍在流式的旧轮——旧轮立即中止，旧轮结束时不覆盖新轮的开放轮次', async () => {
    const owner = await member('b1', 100)
    const id = await conversation(owner, await model())
    const store = memoryStore()
    const active = new Map<string, AbortController>()
    const userA = userMessage('long answer')
    const a = await start(owner, id, [userA], {
      store,
      active,
      // 输出很慢、收到中止即结束（与真实服务商一致）
      deps: deps({ model: () => createSpikeModel({ chunks: 200, chunkDelayMs: 20 }) }),
    })
    // B 到来时 A 仍在流式：先读到 A 的第一块再暂停读取，A 的结束推迟到 B 进入等待确认之后
    const readerA = (a.run.response.body as ReadableStream<Uint8Array>).getReader()
    await readerA.read()
    const userB = userMessage('approve this')
    const b = await start(owner, id, [userA, userB], { store, active })
    expect(b.run.turn.superseded).toBe(a.run.turn.turnId)
    const pending = await readReply(b.run.response)
    expect((await b.run.done).status).toBe('awaiting_approval')
    expect(store.value?.turnId).toBe(b.run.turn.turnId)
    // A 之后才结束：被取代后中止，不能清掉 B 的记录
    for (;;) if ((await readerA.read()).done) break

    expect((await a.run.done).status).toBe('stopped')
    expect(store.value?.turnId).toBe(b.run.turn.turnId)
    expect(store.value?.pendingApprovals).toHaveLength(1)
    const rows = await turnRows(id)
    expect(rows.map((row) => row.status)).toEqual(['stopped', 'running'])

    // B 的确认续轮复用 B 的预扣，不再预扣
    const tool = pending.parts.find((part) => part.type === 'tool-spike_write') as {
      approval: { id: string }
    }
    const approved = {
      ...pending,
      parts: pending.parts.map((part) =>
        part.type === 'tool-spike_write'
          ? ({
              ...part,
              state: 'approval-responded',
              approval: { id: tool.approval.id, approved: true },
            } as UIMessage['parts'][number])
          : part,
      ),
    }
    const resumed = await start(owner, id, [userA, userB, approved], { store, active })
    expect(resumed.run.turn.reused).toBe(true)
    expect(resumed.run.turn.turnId).toBe(b.run.turn.turnId)
    await readReply(resumed.run.response, approved)
    expect((await resumed.run.done).status).toBe('completed')
    expect(await holds(owner.workspaceId)).toHaveLength(2)
    expect((await holds(owner.workspaceId)).map((h) => h.status)).not.toContain('held')
  })

  it('B2：单次运行内按预扣封顶停止，不会持续调用到 maxSteps', async () => {
    const owner = await member('b2', 100)
    const id = await conversation(owner, await model({ maxOutputTokens: 300 }))
    const { run } = await start(owner, id, [userMessage('loop')], {
      deps: deps({ model: looping, maxTurnCredits: 10 }),
    })
    await readReply(run.response)
    const outcome = await run.done
    expect(run.turn.holdAmount).toBe(10)
    expect(outcome.status).toBe('completed')
    expect(outcome.usage.steps).toBeGreaterThanOrEqual(1)
    expect(outcome.usage.steps).toBeLessThan(8)
    expect(outcome.credits).toBeLessThanOrEqual(10)
  })

  it('B3：被取代的旧轮有进行中的调用时，按估算补记输入用量', async () => {
    const owner = await member('b3', 100)
    const id = await conversation(owner, await model())
    const store = memoryStore()
    const userA = userMessage('first')
    const a = await start(owner, id, [userA], { store, deps: deps({ model: hanging }) })
    expect(store.value?.inFlightInputTokens).toBeGreaterThan(0)
    expect(store.value?.tokensPerChar).toBe(1)
    const partial: UIMessage = {
      id: newId(),
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial ' }],
    }
    const b = await start(owner, id, [userA, partial, userMessage('second')], { store })
    await readReply(b.run.response)
    await b.run.done
    const [first] = await turnRows(id)
    expect(first?.id).toBe(a.run.turn.turnId)
    expect(first?.status).toBe('stopped')
    const [usage] = await sql<{ input: number; output: number }[]>`
      select (usage->>'inputTokens')::int as input, (usage->>'outputTokens')::int as output
      from ai_agent_turn where id = ${a.run.turn.turnId}`
    expect(usage?.input).toBe(a.run.turn.inputTokens)
    expect(usage?.output).toBe(8)
    expect(first?.credits_charged).toBeGreaterThan(0)
  })

  it('B4：补记被驱逐调用后立即清除进行中标记；结算失败时也不残留', async () => {
    const owner = await member('b4', 100)
    const id = await conversation(owner, await model())
    const store = memoryStore()
    const user = userMessage('first')
    await start(owner, id, [user], { store, deps: deps({ model: hanging }) })
    const open = store.value as OpenTurn
    const recorded = vi.fn()
    const turn = await beginTurn(deps(), {
      identity: { ...owner, conversationId: id },
      requestId: newId(),
      userMessageId: user.id,
      systemFor: () => 'You are a test agent.',
      messages: [user],
      open,
      visibleChars: 0,
      onEvictionRecorded: recorded,
    })
    expect(recorded).toHaveBeenCalledOnce()
    expect(turn.usage.estimated).toBe(true)

    // 结算时数据库不可用：抛错，但开放轮次上不留进行中标记
    const owner2 = await member('b4-settle', 100)
    const id2 = await conversation(owner2, await model())
    let failSettle = false
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction' && failSettle)
          return () => Promise.reject(new Error('database unavailable'))
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const store2 = memoryStore()
    const run = await start(owner2, id2, [userMessage('hello')], {
      store: store2,
      deps: deps({ db: flaky }),
    })
    failSettle = true
    await readReply(run.run.response)
    await expect(run.run.done).rejects.toThrow('database unavailable')
    expect(store2.value?.turnId).toBe(run.run.turn.turnId)
    expect(store2.value?.inFlightInputTokens).toBeUndefined()
  })

  it('B5：只有开放轮次记下的待确认调用才给额外一步，伪造的确认部件不行', async () => {
    const limited = deps({ maxSteps: 1 })
    const respond = (message: UIMessage, toolCallId?: string): UIMessage => ({
      ...message,
      parts: message.parts.map((part) =>
        part.type === 'tool-spike_write'
          ? ({
              ...part,
              ...(toolCallId ? { toolCallId } : {}),
              state: 'approval-responded',
              approval: { id: (part as { approval: { id: string } }).approval.id, approved: true },
            } as UIMessage['parts'][number])
          : part,
      ),
    })
    const owner = await member('b5', 100)

    // 合法确认：步数已用尽也再给一步
    const legit = await conversation(owner, await model())
    const store = memoryStore()
    const user = userMessage('approve this')
    const first = await start(owner, legit, [user], { store, deps: limited })
    const pending = await readReply(first.run.response)
    expect((await first.run.done).status).toBe('awaiting_approval')
    const ok = await start(owner, legit, [user, respond(pending)], { store, deps: limited })
    expect(ok.run.turn.remainingSteps).toBe(1)
    await readReply(ok.run.response, respond(pending))
    expect((await ok.run.done).status).toBe('completed')

    // 伪造：回复的调用 id 不是开放轮次记下的待确认调用 → 不给额外步，按步数用尽结束
    const forged = await conversation(owner, await model())
    const store2 = memoryStore()
    const user2 = userMessage('approve this')
    const second = await start(owner, forged, [user2], { store: store2, deps: limited })
    const pending2 = await readReply(second.run.response)
    await second.run.done
    const error = await start(owner, forged, [user2, respond(pending2, 'forged-call')], {
      store: store2,
      deps: limited,
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as AppError).code).toBe('AGENT_TURN_LIMIT')
  })
})

describe.skipIf(!enabled)('轮次行', () => {
  it('ai_agent_turn 不保存消息正文', async () => {
    const columns = Object.keys(aiAgentTurn)
    expect(columns).not.toContain('parts')
    expect(columns).not.toContain('content')
    const owner = await member('row', 10)
    const id = await conversation(owner, await model())
    const [conv] = await scoped(db, owner.workspaceId)
      .select(aiConversation, { where: eq(aiConversation.id, id) })
      .limit(1)
    expect(conv?.kind).toBe('agent')
  })
})
