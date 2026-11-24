import { env } from 'cloudflare:workers'
import {
  cleanupExpiredWorkspaces,
  createAuth,
  type DeletionContext,
  deleteTeamWorkspace,
  restoreWorkspace,
} from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { grant } from '@saas/credits'
import {
  type AiPricingJson,
  aiAgentTurn,
  aiConversation,
  aiModel,
  aiTask,
  createDb,
  scoped,
} from '@saas/db'
import { newId } from '@saas/shared'
import type { UIMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  applyTaskResults,
  findPendingTasks,
  readTaskResults,
} from '../../../plugins/agents/src/core/async-tasks.ts'
import {
  createAgentAccountDeletionStep,
  registerAgentDeletionSteps,
} from '../../../plugins/agents/src/core/deletion.ts'
import {
  deleteOwnAgentConversation,
  LIFECYCLE_CHECK_MAX_DAYS,
  RUNNING_TURN_RECHECK_MS,
  reviewAgentConversation,
} from '../../../plugins/agents/src/core/lifecycle.ts'
import { authorizeAgentRequest } from '../../../plugins/agents/src/worker/gate.ts'
import { mediaAgentTools } from '../../../plugins/media/src/web/agent-tools.ts'
import templateConfig from '../../../template.config.ts'

// openspec add-ai-agents 7.1–7.3、8.1、8.2：删除对话后 404 与实例清理、删号 / 删空间的清理步骤
// （部分失败由实例 alarm 兜底、重复执行幂等）、实例 alarm 的孤儿清理与保留期、媒体工具的幂等提交、
// 异步任务结果写回且不产生新的费用。Durable Object 适配层只转发，这里驱动与 SDK 无关的函数。

const enabled = Boolean(templateConfig.plugins.agents)
const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const APP_URL = 'http://localhost:3000'
const PASSWORD = 'correct-horse-battery-staple'
const EMAIL_DOMAIN = `${newId()}.web-agents-lifecycle.example`
const MODEL_KEY_PREFIX = `agents-lifecycle-${newId()}-`
const PRICING: AiPricingJson = { mode: 'token', inputPer1k: 10, outputPer1k: 10 }
const DAY_MS = 86_400_000
const plans: string[] = []
const teamWorkspaces: string[] = []

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

type Owner = Awaited<ReturnType<typeof member>>

async function conversation(owner: Owner, options: { updatedAt?: Date } = {}) {
  const id = newId()
  await scoped(db, owner.workspaceId).insert(aiConversation, {
    id,
    userId: owner.userId,
    modelKey: `${MODEL_KEY_PREFIX}text`,
    kind: 'agent',
    agentId: 'assistant',
    title: 'lifecycle test',
  })
  if (options.updatedAt)
    await sql`update ai_conversation set updated_at=${options.updatedAt.toISOString()} where id=${id}`
  return id
}

async function turn(owner: Owner, conversationId: string, status: 'running' | 'completed') {
  await scoped(db, owner.workspaceId).insert(aiAgentTurn, {
    userId: owner.userId,
    conversationId,
    requestId: newId(),
    modelKey: `${MODEL_KEY_PREFIX}text`,
    pricing: PRICING,
    status,
  })
}

async function conversationRow(id: string) {
  const [row] = await sql<{ archived: boolean }[]>`
    select archived from ai_conversation where id=${id}`
  return row
}

async function turnCount(conversationId: string) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ai_agent_turn where conversation_id=${conversationId}`
  return row?.n ?? 0
}

async function ledger(workspaceId: string) {
  const [row] = await sql<{ entries: number; holds: number }[]>`
    select (select count(*)::int from credit_ledger where workspace_id=${workspaceId}) as entries,
           (select count(*)::int from credit_hold where workspace_id=${workspaceId}) as holds`
  return row
}

const gate = (conversationId: string, who: Owner) =>
  authorizeAgentRequest(
    new Request(`${APP_URL}/agents/agent-conversation/${conversationId}`, {
      headers: { cookie: who.cookie },
    }),
    conversationId,
    { db, auth },
  )

afterAll(async () => {
  const ids = sql`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  for (const plan of plans) {
    await sql`delete from subscription where plan_id=${plan}`
    await sql`delete from plan_price where plan_id=${plan}`
    await sql`delete from plan where id=${plan}`
  }
  await sql`delete from ai_agent_turn where workspace_id in (${ids})`
  await sql`delete from ai_conversation where workspace_id in (${ids})`
  await sql`delete from ai_task where workspace_id in (${ids})`
  await sql`delete from credit_hold_allocation where hold_id in
    (select id from credit_hold where workspace_id in (${ids}))`
  await sql`delete from credit_ledger where workspace_id in (${ids})`
  await sql`delete from credit_hold where workspace_id in (${ids})`
  await sql`delete from credit_grant where workspace_id in (${ids})`
  await sql`delete from credit_debt where workspace_id in (${ids})`
  await sql`delete from session where user_id in (${ids})`
  await sql`delete from account where user_id in (${ids})`
  await sql`delete from member where user_id in (${ids})`
  // audit_log 对 app 只追加：删空间与恢复写入的审计行改用 migrator 清理
  const migrator = createDb(env.HYPERDRIVE_MIGRATOR).$client
  await migrator`delete from audit_log where actor_user_id in (${migrator`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`})`
  if (teamWorkspaces.length) {
    await migrator`delete from audit_log where workspace_id in ${migrator(teamWorkspaces)}`
    await sql`delete from organization where id in ${sql(teamWorkspaces)}`
  }
  await sql`delete from organization where id in (${ids})`
  await sql`delete from "user" where id in (${ids})`
  await sql`delete from ai_model where key like ${`${MODEL_KEY_PREFIX}%`}`
})

describe.skipIf(!enabled)('用户删除对话（7.1）', () => {
  it('软删 PG 行并清理实例，之后连接返回 404；他人不能删除', async () => {
    const alice = await member('alice')
    const bob = await member('bob')
    const id = await conversation(alice)
    expect(await gate(id, alice)).toBeInstanceOf(Request)

    const cleaner = vi.fn(async () => {})
    await expect(
      deleteOwnAgentConversation(
        db,
        { workspaceId: bob.workspaceId, userId: bob.userId, conversationId: id },
        cleaner,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(cleaner).not.toHaveBeenCalled()

    const result = await deleteOwnAgentConversation(
      db,
      { workspaceId: alice.workspaceId, userId: alice.userId, conversationId: id },
      cleaner,
    )
    expect(result).toEqual({ id, instancePurged: true })
    expect(cleaner).toHaveBeenCalledExactlyOnceWith(id)
    expect(await conversationRow(id)).toEqual({ archived: true })
    const denied = await gate(id, alice)
    expect(denied).toBeInstanceOf(Response)
    expect((denied as Response).status).toBe(404)
    // 再删一次同样是 404（已删除即不存在）
    await expect(
      deleteOwnAgentConversation(
        db,
        { workspaceId: alice.workspaceId, userId: alice.userId, conversationId: id },
        cleaner,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('实例清理失败不回滚 PG；实例 alarm 到期时发现已删除并自清理', async () => {
    const alice = await member('alice')
    const id = await conversation(alice)
    const result = await deleteOwnAgentConversation(
      db,
      { workspaceId: alice.workspaceId, userId: alice.userId, conversationId: id },
      async () => {
        throw new Error('durable object unavailable')
      },
    )
    expect(result.instancePurged).toBe(false)
    expect(await conversationRow(id)).toEqual({ archived: true })
    expect(
      await reviewAgentConversation(db, { workspaceId: alice.workspaceId, conversationId: id }),
    ).toEqual({ action: 'purge', reason: 'archived' })
  })
})

describe.skipIf(!enabled)('删号清理步骤（7.2）', () => {
  async function runStep(context: DeletionContext, cleaner: (id: string) => Promise<void>) {
    const step = createAgentAccountDeletionStep(() => cleaner)
    await sql.begin((tx) => step.execute?.(context, tx))
    await step.after?.(context)
  }

  it('删除该用户在个人与团队空间中的 agent 对话（先删轮次）；部分实例失败不阻塞其余，之后由 alarm 兜底；重复执行幂等', async () => {
    const leaving = await member('leaving')
    const teammate = await member('teammate')
    // 该用户在他人空间（如团队空间）中的对话同样删除：对话只对创建者可见
    await sql`insert into member (id, organization_id, user_id, role, created_at)
      values (${newId()}, ${teammate.workspaceId}, ${leaving.userId}, 'member', now())`
    const own = await conversation(leaving)
    const elsewhere = await conversation({ ...leaving, workspaceId: teammate.workspaceId })
    const teammates = await conversation(teammate)
    await turn(leaving, own, 'completed')
    await turn(teammate, teammates, 'completed')

    const calls: string[] = []
    const cleaner = async (id: string) => {
      calls.push(id)
      if (id === own) throw new Error('instance call failed')
    }
    const context = { actorUserId: leaving.userId, workspaceIds: [leaving.workspaceId], db }
    await runStep(context, cleaner)
    expect(calls.sort()).toEqual([own, elsewhere].sort())
    expect(await conversationRow(own)).toBeUndefined()
    expect(await turnCount(own)).toBe(0)
    expect(await conversationRow(elsewhere)).toBeUndefined()
    expect(await conversationRow(teammates)).toEqual({ archived: false })
    expect(await turnCount(teammates)).toBe(1)
    // 实例调用失败的对话：PG 已无记录，实例 alarm 到期时自清理
    expect(
      await reviewAgentConversation(db, { workspaceId: leaving.workspaceId, conversationId: own }),
    ).toEqual({ action: 'purge', reason: 'missing' })

    // 重试（再次执行）不报错、不再触碰其他数据
    const retry = vi.fn(async () => {})
    await runStep(context, retry)
    expect(retry).not.toHaveBeenCalled()
    expect(await conversationRow(teammates)).toEqual({ archived: false })
  })
})

describe.skipIf(!enabled)('删团队空间：保留期内可恢复，期满由 jobs 清理（7.2）', () => {
  it('软删时不清 agent 数据、访问 404；恢复后对话完整可访问；保留期满清理后实例在下次检查时自清理', async () => {
    const owner = await member('team-owner')
    const admin = await member('team-admin')
    await sql`update "user" set role='admin' where id=${admin.userId}`
    const workspaceId = newId()
    await sql`insert into organization (id, name, slug, is_personal) values (${workspaceId}, 'Agents team', ${`agents-team-${workspaceId}`}, false)`
    teamWorkspaces.push(workspaceId)
    await sql`insert into member (id, organization_id, user_id, role, created_at)
      values (${newId()}, ${workspaceId}, ${owner.userId}, 'owner', now())`
    const team = { ...owner, workspaceId }
    const id = await conversation(team)
    await turn(team, id, 'completed')
    // 与生产一致：只注册删号步骤
    const cleaner = vi.fn(async (_id: string) => {})
    const dispose = registerAgentDeletionSteps(() => cleaner)
    try {
      await deleteTeamWorkspace({
        db,
        auth,
        headers: new Headers({ cookie: owner.cookie }),
        workspaceId,
        multiTenant: true,
      })
    } finally {
      dispose()
    }
    expect(cleaner).not.toHaveBeenCalled()
    expect(await conversationRow(id)).toEqual({ archived: false })
    expect(await turnCount(id)).toBe(1)
    expect(((await gate(id, owner)) as Response).status).toBe(404)
    // 软删期间实例 alarm 只顺延，不清空
    expect(await reviewAgentConversation(db, { workspaceId, conversationId: id })).toMatchObject({
      action: 'reschedule',
    })

    await restoreWorkspace({
      db,
      auth,
      headers: new Headers({ cookie: admin.cookie }),
      workspaceId,
    })
    const restored = await gate(id, owner)
    expect(restored).toBeInstanceOf(Request)
    expect(await turnCount(id)).toBe(1)

    // 再次删除并超过保留期：jobs 的过期空间清理先删轮次再删对话；实例下次检查时发现对话不存在
    await deleteTeamWorkspace({
      db,
      auth,
      headers: new Headers({ cookie: owner.cookie }),
      workspaceId,
      multiTenant: true,
    })
    await sql`update organization set deleted_at=now()-interval '31 days' where id=${workspaceId}`
    await cleanupExpiredWorkspaces(db)
    expect(await conversationRow(id)).toBeUndefined()
    expect(await turnCount(id)).toBe(0)
    expect(await reviewAgentConversation(db, { workspaceId, conversationId: id })).toEqual({
      action: 'purge',
      reason: 'missing',
    })
  })
})

describe.skipIf(!enabled)('实例 alarm：孤儿清理与保留期（7.2、7.3）', () => {
  it('未开启保留期：只检查对话是否存在，长期无活动的对话不删除，按最近活动顺延（≤ 30 天）', async () => {
    const alice = await member('alice')
    const now = new Date()
    const stale = await conversation(alice, { updatedAt: new Date(now.getTime() - 400 * DAY_MS) })
    const review = await reviewAgentConversation(db, {
      workspaceId: alice.workspaceId,
      conversationId: stale,
      now,
    })
    expect(review).toMatchObject({ action: 'reschedule', reason: 'active' })
    if (review.action !== 'reschedule') throw new Error('unreachable')
    expect(review.at.getTime() - now.getTime()).toBe(LIFECYCLE_CHECK_MAX_DAYS * DAY_MS)
    expect(await conversationRow(stale)).toEqual({ archived: false })

    // 孤儿：PG 中没有这个对话（或在他人空间中）→ 清空实例
    expect(
      await reviewAgentConversation(db, {
        workspaceId: alice.workspaceId,
        conversationId: newId(),
      }),
    ).toEqual({ action: 'purge', reason: 'missing' })
  })

  it('超过保留期且没有 running 轮次：按删除语义删除 PG 行（列表消失、连接 404）', async () => {
    const alice = await member('alice')
    const now = new Date()
    const expired = await conversation(alice, { updatedAt: new Date(now.getTime() - 91 * DAY_MS) })
    const fresh = await conversation(alice, { updatedAt: new Date(now.getTime() - 10 * DAY_MS) })
    await turn(alice, expired, 'completed')

    expect(
      await reviewAgentConversation(db, {
        workspaceId: alice.workspaceId,
        conversationId: expired,
        retentionDays: 90,
        now,
      }),
    ).toEqual({ action: 'expired' })
    expect(await conversationRow(expired)).toEqual({ archived: true })
    expect(((await gate(expired, alice)) as Response).status).toBe(404)

    // 未到期：下次检查不晚于保留期到期时刻（10 天前活动 → 30 天窗口内的第 20 天）
    const review = await reviewAgentConversation(db, {
      workspaceId: alice.workspaceId,
      conversationId: fresh,
      retentionDays: 90,
      now,
    })
    expect(review).toMatchObject({ action: 'reschedule', reason: 'active' })
    if (review.action !== 'reschedule') throw new Error('unreachable')
    const updatedAt = (
      await db
        .select({ updatedAt: aiConversation.updatedAt })
        .from(aiConversation)
        .where(eq(aiConversation.id, fresh))
    )[0]?.updatedAt as Date
    expect(review.at.getTime()).toBe(updatedAt.getTime() + 30 * DAY_MS)
  })

  it('超过保留期但有 running 轮次：本次跳过，稍后重查', async () => {
    const alice = await member('alice')
    const now = new Date()
    const busy = await conversation(alice, { updatedAt: new Date(now.getTime() - 91 * DAY_MS) })
    await turn(alice, busy, 'running')
    const review = await reviewAgentConversation(db, {
      workspaceId: alice.workspaceId,
      conversationId: busy,
      retentionDays: 90,
      now,
    })
    expect(review).toMatchObject({ action: 'reschedule', reason: 'running' })
    if (review.action !== 'reschedule') throw new Error('unreachable')
    expect(review.at.getTime() - now.getTime()).toBe(RUNNING_TURN_RECHECK_MS)
    expect(await conversationRow(busy)).toEqual({ archived: false })
  })
})

describe.skipIf(!enabled || !templateConfig.plugins.media || !templateConfig.ai.video)(
  '异步媒体工具（8.1、8.2）',
  () => {
    function toolMessages(outputs: { toolCallId: string; output: unknown }[]): UIMessage[] {
      return [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'make pictures' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            ...outputs.map(({ toolCallId, output }) => ({
              type: 'tool-generate_image' as const,
              toolCallId,
              state: 'output-available' as const,
              input: { prompt: 'x' },
              output,
            })),
            { type: 'text' as const, text: 'Submitted.' },
          ],
        },
      ] as UIMessage[]
    }

    async function task(owner: Owner, status: 'running' | 'succeeded' | 'failed', deadline: Date) {
      const id = newId()
      await scoped(db, owner.workspaceId).insert(aiTask, {
        id,
        userId: owner.userId,
        kind: 'image',
        modelKey: `${MODEL_KEY_PREFIX}image`,
        provider: 'fal',
        pricing: { mode: 'per_call', credits: 3 },
        status,
        input: { params: { prompt: 'x' } },
        output: status === 'succeeded' ? { files: [{ id: newId(), mime: 'image/png' }] } : null,
        errorCode: status === 'failed' ? 'PROVIDER_FAILED' : null,
        providerRequestKey: id,
        deadlineAt: deadline,
      })
      return id
    }

    it('终态写回同一工具调用的输出；进行中的继续等待，超时写超时结果；不产生积分流水', async () => {
      const alice = await member('alice', 100)
      const intruder = await member('intruder')
      const later = new Date(Date.now() + DAY_MS)
      const done = await task(alice, 'succeeded', later)
      const failed = await task(alice, 'failed', later)
      const running = await task(alice, 'running', later)
      const overdue = await task(alice, 'running', new Date(Date.now() - DAY_MS))
      const foreign = await task(intruder, 'succeeded', later)
      const messages = toolMessages(
        [done, failed, running, overdue, foreign].map((taskId, index) => ({
          toolCallId: `call-${index}`,
          output: { taskId, status: 'pending', kind: 'image' },
        })),
      )
      const before = await ledger(alice.workspaceId)

      const pending = findPendingTasks(messages)
      expect(pending.map((ref) => ref.taskId)).toEqual([done, failed, running, overdue, foreign])
      const results = await readTaskResults(db, alice.workspaceId, pending)
      const updated = applyTaskResults(messages, results)

      const outputs = Object.fromEntries(
        (updated[1]?.parts ?? []).flatMap((part) =>
          'toolCallId' in part ? [[part.toolCallId, part.output]] : [],
        ),
      )
      expect(outputs['call-0']).toMatchObject({
        taskId: done,
        status: 'succeeded',
        files: [{ mime: 'image/png', downloadUrl: expect.stringContaining(alice.workspaceId) }],
      })
      expect(outputs['call-1']).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_FAILED' })
      expect(outputs['call-2']).toEqual({ taskId: running, status: 'pending', kind: 'image' })
      expect(outputs['call-3']).toMatchObject({ status: 'timeout', errorCode: 'TASK_TIMEOUT' })
      // 他人空间的任务按不存在处理，不泄露结果
      expect(outputs['call-4']).toMatchObject({ status: 'failed', errorCode: 'TASK_NOT_FOUND' })
      expect(findPendingTasks(updated).map((ref) => ref.taskId)).toEqual([running])
      // 写回只改消息：没有新的预扣与积分流水（默认不自动续轮，不调用模型）
      expect(await ledger(alice.workspaceId)).toEqual(before)
      // 没有终态结果时不产生新数组（实例不写存储）
      expect(applyTaskResults(updated, new Map())).toBe(updated)
    })

    /** 工具使用真实权益：给空间一个允许全部模型的有效订阅 */
    async function subscribe(workspaceId: string) {
      const [plan, price, subscription] = [newId(), newId(), newId()]
      plans.push(plan)
      await sql`insert into plan(id,key,name,type,credits,features) values(${plan},${`${MODEL_KEY_PREFIX}${plan}`},'Fixture','subscription',0,'{"models":["*"],"maxConcurrentTasks":3,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":false}'::jsonb)`
      await sql`insert into plan_price(id,plan_id,provider,provider_price_id,amount,currency) values(${price},${plan},'stripe',${price},100,'USD')`
      await sql`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,provider_subscription_id,status,current_period_end,last_event_at) values(${subscription},${workspaceId},${plan},${price},'stripe',${subscription},'active',now()+interval '30 days',now())`
    }

    it('generate_video 需要确认；同一 idempotencyKey 重放只创建一个任务与一次预扣，返回 pending 结果', async () => {
      const alice = await member('alice', 500)
      await subscribe(alice.workspaceId)
      // 排在所有视频模型之前，成为该空间的默认视频模型
      await db.insert(aiModel).values({
        key: `${MODEL_KEY_PREFIX}video`,
        kind: 'video',
        provider: 'fal',
        providerModelId: 'fal-ai/fixture-video',
        pricing: { mode: 'per_call', credits: 5 },
        sort: -2_000_000_000,
        paramsSchema: {
          type: 'object',
          required: ['prompt'],
          properties: { prompt: { type: 'string', minLength: 1 } },
        },
      })
      const video = mediaAgentTools().find((tool) => tool.name === 'generate_video')
      expect(video).toBeDefined()
      const instance = {
        id: 'fixture',
        status: async () => ({ status: 'running' as const }),
        terminate: async () => {},
        sendEvent: async () => {},
      }
      const create = vi.fn(
        async (_options: { id?: string; params: { taskId: string } }) => instance,
      )
      const turnId = newId()
      const context = (toolCallId: string) => ({
        workspaceId: alice.workspaceId,
        userId: alice.userId,
        conversationId: newId(),
        idempotencyKey: `${turnId}:${toolCallId}`,
        signal: undefined,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        db,
        services: {
          env: { APP_URL, FAL_KEY: 'fixture', MEDIA_WEBHOOK_SECRET: 'fixture' },
          aiWorkflow: {
            available: true as const,
            value: { create, get: async () => instance },
          },
          rateLimiter: { limit: async () => ({ success: true }) },
        },
      })
      const bound = (toolCallId: string) =>
        video?.bind(() => context(toolCallId)) as unknown as {
          needsApproval: unknown
          execute: (input: unknown, call: { toolCallId: string }) => Promise<unknown>
        }

      expect(bound('call-1').needsApproval).toBe(true)
      const first = await bound('call-1').execute({ prompt: 'a cat' }, { toolCallId: 'call-1' })
      const replay = await bound('call-1').execute({ prompt: 'a cat' }, { toolCallId: 'call-1' })
      expect(first).toMatchObject({ status: 'pending', kind: 'video' })
      expect(replay).toEqual(first)
      expect(create).toHaveBeenCalledTimes(1)
      const rows = await sql<{ id: string; hold_id: string | null }[]>`
      select id, hold_id from ai_task where workspace_id=${alice.workspaceId}`
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe((first as { taskId: string }).taskId)
      const [holds] = await sql<{ n: number }[]>`
      select count(*)::int as n from credit_hold where workspace_id=${alice.workspaceId} and ref_type='ai_task'`
      expect(holds?.n).toBe(1)

      // 另一个工具调用（新的幂等键）会提交新任务
      await bound('call-2').execute({ prompt: 'a dog' }, { toolCallId: 'call-2' })
      expect(create).toHaveBeenCalledTimes(2)
    })
  },
)
