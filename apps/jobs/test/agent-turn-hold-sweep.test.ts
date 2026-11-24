import { env } from 'cloudflare:workers'
import { runHoldSweep } from '@saas/billing'
import { defineTemplateConfig } from '@saas/config'
import { getCreditBalance, grant, hold } from '@saas/credits'
import {
  type AiPricingJson,
  aiAgentTurn,
  aiConversation,
  createDb,
  member,
  organization,
  scoped,
  user,
} from '@saas/db'
import { afterAll, describe, expect, it } from 'vitest'
import agentsJobs from '../../../plugins/agents/src/jobs/index.ts'
import templateConfig from '../../../template.config.ts'
import { registerPluginHoldSweepers } from '../src/plugins/register.ts'

// openspec add-ai-agents 4.4：agent_turn 预扣到期后，jobs 清理器只操作 PG，按 turn 行上的检查点结算并标记
// expired（等待确认超时同样走这里）；turn 已终态或缺失时释放预扣；重复执行不重复结算。

const enabled = Boolean(templateConfig.plugins.agents)
const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const id = () => crypto.randomUUID()
const workspaces: string[] = []
const PRICING: AiPricingJson = { mode: 'token', inputPer1k: 10, outputPer1k: 10 }
const template = defineTemplateConfig({
  app: {
    name: 'Agent hold sweep fixture',
    url: 'https://agent-sweep.example.test',
    supportEmail: 'support@agent-sweep.example.test',
  },
  plugins: { agents: {} },
})
const unregister = enabled ? registerPluginHoldSweepers([agentsJobs], template) : () => undefined

afterAll(async () => {
  unregister()
  for (const ws of workspaces) {
    await sql`delete from ai_agent_turn where workspace_id=${ws}`
    await sql`delete from ai_conversation where workspace_id=${ws}`
    await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id=${ws})`
    await sql`delete from credit_ledger where workspace_id=${ws}`
    await sql`delete from credit_hold where workspace_id=${ws}`
    await sql`delete from credit_grant where workspace_id=${ws}`
    await sql`delete from credit_debt where workspace_id=${ws}`
    await sql`delete from member where organization_id=${ws}`
    await sql`delete from organization where id=${ws}`
    await sql`delete from "user" where id=${ws}`
  }
})

async function fixture(options: {
  checkpoint: Record<string, unknown>
  status?: 'running' | 'completed'
  holdAmount?: number
}) {
  const workspaceId = id()
  workspaces.push(workspaceId)
  await db.insert(user).values({
    id: workspaceId,
    name: 'Agent sweep',
    email: `${workspaceId}@agent-sweep.example.test`,
  })
  await db.insert(organization).values({ id: workspaceId, name: 'Agent sweep', slug: workspaceId })
  await db
    .insert(member)
    .values({ id: id(), userId: workspaceId, organizationId: workspaceId, role: 'owner' })
  await grant(db, { workspaceId, source: 'admin', sourceRef: id(), amount: 100 })
  const conversationId = id()
  await scoped(db, workspaceId).insert(aiConversation, {
    id: conversationId,
    userId: workspaceId,
    modelKey: 'agent-sweep-model',
    kind: 'agent',
    agentId: 'assistant',
  })
  const turnId = id()
  const reservation = await hold(db, {
    workspaceId,
    userId: workspaceId,
    amount: options.holdAmount ?? 40,
    refType: 'agent_turn',
    refId: turnId,
    expiresAt: new Date(Date.now() - 60_000),
  })
  await scoped(db, workspaceId).insert(aiAgentTurn, {
    id: turnId,
    userId: workspaceId,
    conversationId,
    requestId: id(),
    modelKey: 'agent-sweep-model',
    pricing: PRICING,
    holdId: reservation.id,
    status: options.status ?? 'running',
    usageCheckpoint: { at: new Date().toISOString(), ...options.checkpoint } as never,
  })
  return { workspaceId, turnId, holdId: reservation.id }
}

async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const [turn] = await sql<{ status: string; credits_charged: number; error_code: string }[]>`
    select status, credits_charged, error_code from ai_agent_turn where id=${f.turnId}`
  const [reservation] = await sql<{ status: string; captured_amount: number }[]>`
    select status, captured_amount from credit_hold where id=${f.holdId}`
  const [invariant] = await sql<{ valid: boolean }[]>`
    select (select coalesce(sum(delta),0) from credit_ledger where workspace_id=${f.workspaceId}) =
      (select coalesce(sum(remaining),0) from credit_grant where workspace_id=${f.workspaceId} and status='active') +
      (select coalesce(sum(amount),0) from credit_hold where workspace_id=${f.workspaceId} and status='held') -
      (select coalesce(sum(amount),0) from credit_debt where workspace_id=${f.workspaceId}) as valid`
  expect(invariant?.valid).toBe(true)
  return { turn, hold: reservation, balance: await getCreditBalance(db, f.workspaceId) }
}

async function sweep() {
  const result = await runHoldSweep(db)
  expect(result.failures.filter((failure) => workspaces.includes(failure.workspaceId))).toEqual([])
}

describe.skipIf(!enabled)('agentTurnHoldSweeper', () => {
  it('过期的 running 轮次按检查点结算并标记 expired；重复执行不重复结算', async () => {
    // 两步：1000 输入 + 500 输出 token × 0.01 = 15 积分
    const f = await fixture({
      checkpoint: {
        inputTokens: 1000,
        outputTokens: 500,
        steps: 2,
        failedReplyRefund: 'no-visible-output',
      },
    })
    await sweep()
    await sweep()
    expect(await state(f)).toMatchObject({
      turn: { status: 'expired', credits_charged: 15, error_code: 'HOLD_EXPIRED' },
      hold: { status: 'captured', captured_amount: 15 },
      balance: { available: 85, held: 0 },
    })
  })

  it('估算用量超过预扣时以预扣额封顶', async () => {
    const f = await fixture({
      checkpoint: { inputTokens: 90_000, outputTokens: 0, steps: 1, estimated: true },
      holdAmount: 30,
    })
    await sweep()
    expect(await state(f)).toMatchObject({
      turn: { status: 'expired', credits_charged: 30 },
      hold: { status: 'captured', captured_amount: 30 },
    })
  })

  it('等待确认超时但没有任何用量：释放预扣', async () => {
    const f = await fixture({ checkpoint: { inputTokens: 0, outputTokens: 0, steps: 0 } })
    await sweep()
    expect(await state(f)).toMatchObject({
      turn: { status: 'expired', credits_charged: 0 },
      hold: { status: 'released' },
      balance: { available: 100, held: 0 },
    })
  })

  it('turn 已终态但预扣仍持有：只释放预扣，不改 turn', async () => {
    const f = await fixture({
      checkpoint: { inputTokens: 1000, outputTokens: 500, steps: 2 },
      status: 'completed',
    })
    await sweep()
    expect(await state(f)).toMatchObject({
      turn: { status: 'completed', credits_charged: 0 },
      hold: { status: 'released' },
    })
  })
})
