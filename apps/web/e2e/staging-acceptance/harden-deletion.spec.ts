import { createHash, randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import { grant } from '@saas/credits'
import { createDb } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { newId } from '@saas/shared'
import { loadEnv } from 'vite'
import templateConfig from '../../../../template.config.ts'
import { fixtureDb } from '../fixtures.ts'
import { stubTurnstile } from '../turnstile.ts'
import { ensureAcceptanceCredits, HUMAN_LOGIN_TIMEOUT } from './accounts.ts'
import {
  dedicatedEmail,
  readEvidenceAnyDate,
  requireHeadedForStaging,
  unconfirmed,
} from './harden-support.ts'
import { awaitTerminal, reuseOrSubmit } from './media-support.ts'
import { deepseekCall, workersImage } from './models.ts'
import {
  adminIdentity,
  ensureRegisteredAccount,
  evidence,
  expect,
  local,
  login,
  query,
  requireEnv,
  runId,
  sessionUser,
  sqlLiteral,
  test,
} from './support.ts'

// harden-audit-findings 7.3「删号后数据已清理」（specs/account-deletion「账号匿名化」「删除团队空间」）。
// 写操作只走产品 UI / HTTP：注册、对话、媒体任务、管理员补发积分、删号。
// 本地额外用隔离库夹具补齐 staging 模板关闭的能力（团队空间、newsletter、waitlist）与套餐权益，
// 并直接调用 jobs 的清理 cron；staging 上这些部分如实记为「无法确认」。
test.describe.configure({ mode: 'serial' })

const tag = createHash('sha256').update(runId).digest('hex').slice(0, 10)
const accounts = {
  a: { email: dedicatedEmail('harden-del-a'), name: `Harden Deletion A ${tag}` },
  b: { email: dedicatedEmail('harden-del-b'), name: `Harden Deletion B ${tag}` },
}
const password = `Harden-${randomBytes(12).toString('hex')}`
const teamSlug = `harden-del-${tag}`
const FINANCE_TABLES = [
  'credit_grant',
  'credit_ledger',
  'credit_hold',
  'credit_debt',
  'billing_customer',
  'subscription',
  'purchase',
  'payment',
  'payment_refund',
  'refund_request',
] as const
// 账号删除前要求 10 分钟内的新会话；留 1 分钟余量。
const FRESH_SESSION_MS = 9 * 60_000
// staging jobs 每天 03:00 UTC 运行 workspace-cleanup（apps/jobs/src/cron/workspace-cleanup.ts）。
const CLEANUP_HOUR_UTC = 3
const CLEANUP_GRACE_MS = 30 * 60_000

interface Workspace {
  id: string
  slug: string
}
interface DeletionState {
  userA: string | null
  userB: string
  personal: Workspace
  team: Workspace | null
  deletedAt: string
  personalContent: Counts
  teamContentB: Counts | null
  teamContentA: string | null
  teamFiles: string | null
  finance: Record<string, string>
}
type Counts = { conversations: number; messages: number; tasks: number }

const sessions = new Map<string, number>()

async function register(page: Page, account: 'a' | 'b') {
  const { email, name } = accounts[account]
  const result = await ensureRegisteredAccount(
    page,
    async () =>
      (await query<{ id: string }>(`select id from "user" where email=${sqlLiteral(email)}`))[0],
    email,
    password,
    name,
  )
  if (!result.registered)
    throw new Error(
      '[验收准备] 该 runId 的删号测试账号已存在但没有删号证据；请换一个新的 STAGING_ACCEPTANCE_RUN_ID 重跑',
    )
  sessions.set(account, Date.now())
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  const [workspace] = await query<{ id: string }>(`select o.id from organization o
    join member m on m.organization_id=o.id where o.slug=${sqlLiteral(slug)}
    and m.user_id=${sqlLiteral(result.account.id)} and o.is_personal`)
  if (!workspace) throw new Error('Registered personal workspace missing')
  return { userId: result.account.id, personal: { id: workspace.id, slug } }
}

async function passwordLogin(page: Page, account: 'a' | 'b') {
  if (local) {
    await page
      .context()
      .setExtraHTTPHeaders({ 'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}` })
    await stubTurnstile(page)
  }
  await page.context().clearCookies()
  await page.goto('/login')
  const form = page.getByRole('form', { name: 'Sign in with password' })
  await form.getByLabel('Email', { exact: true }).fill(accounts[account].email)
  await form.getByLabel('Password', { exact: true }).fill(password)
  const timeout = local ? 20_000 : HUMAN_LOGIN_TIMEOUT
  await form.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout })
  await page.waitForURL(/\/app\/[^/?#]+\/?$/, { timeout })
  sessions.set(account, Date.now())
}

/** 本地夹具：给指定空间授予验收模型权益与积分，不调用支付服务商（同 local-setup.ts）。 */
async function seedLocalWorkspace(workspaceId: string) {
  const sql = fixtureDb()
  const worktree = loadEnv('worktree', new URL('../../../../', import.meta.url).pathname, '')
  const db = createDb({ connectionString: worktree.DATABASE_URL ?? '' })
  try {
    const key = `harden-deletion:${runId}`
    await sql`insert into plan(id,key,name,type,credits,features,sort,active)
      values(${newId()},${key},'Harden deletion','subscription',0,
        ${sql.json({ ...DEFAULT_FREE_FEATURES, models: [workersImage.key, deepseekCall.key] })},1000,false)
      on conflict(key) do nothing`
    const [plan] = await sql`select id from plan where key=${key}`
    if (!plan) throw new Error('Missing local plan')
    await sql`insert into plan_price(id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values(${newId()},${plan.id},'stripe',${key},'month',0,'usd',false)
      on conflict(provider,provider_price_id) do nothing`
    const [price] =
      await sql`select id from plan_price where provider='stripe' and provider_price_id=${key}`
    if (!price) throw new Error('Missing local price')
    await sql`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,
      cancel_at_period_end,canceled_at,last_event_at)
      values(${newId()},${workspaceId},${plan.id},${price.id},'stripe',${`${key}:${workspaceId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())
      on conflict(provider,provider_subscription_id) do nothing`
    for (const model of [workersImage, deepseekCall])
      await sql`insert into ai_model(id,key,kind,provider,provider_model_id,pricing,min_plan_features,params_schema,enabled,sort)
        values(${newId()},${model.key},${model.kind},${model.provider},${model.providerModelId},
          ${sql.json(model.pricing)},'[]'::jsonb,${sql.json(model.paramsSchema)},true,${model.sort})
        on conflict(key) do nothing`
    await grant(db, {
      workspaceId,
      source: 'promo',
      sourceRef: `${key}:${workspaceId}`,
      amount: 50,
    })
  } finally {
    await db.$client.end()
    await sql.end()
  }
}

/**
 * 本地夹具：模板 tenancy.multiTenant=false 时，团队空间只能直接写库，且非个人空间对成员只读
 * （apps/web/src/server/middleware.ts 的 workspaceReadOnly），产品无法在其中生成对话与媒体任务。
 * 因此先以「可写」状态（is_personal=true）建空间，让 A、B 经真实产品接口产生内容、预扣与流水，
 * 删号前再切换为团队空间（convertLocalTeam），删号与清理逻辑看到的就是团队空间中的真实数据。
 */
async function seedLocalTeam(owner: string, member: string) {
  const sql = fixtureDb()
  const id = newId()
  try {
    await sql`insert into organization (id,name,slug,created_at,is_personal)
      values (${id},${`Harden deletion team ${tag}`},${teamSlug},now(),true)`
    await sql`insert into member (id,organization_id,user_id,role,created_at) values
      (${newId()},${id},${owner},'owner',now()), (${newId()},${id},${member},'member',now())`
  } finally {
    await sql.end()
  }
  return { id, slug: teamSlug }
}

async function convertLocalTeam(id: string) {
  const sql = fixtureDb()
  try {
    await sql`update organization set is_personal=false, updated_at=now() where id=${id}`
  } finally {
    await sql.end()
  }
}

/** 本地夹具：staging 关闭了 newsletter / waitlist，直接写入 B 的增长名单记录。 */
async function seedLocalGrowth(email: string) {
  const sql = fixtureDb()
  try {
    await sql`insert into newsletter_subscriber (id,email,status,confirm_token)
      values (${newId()},${email},'confirmed',${newId()}) on conflict (email) do nothing`
    await sql`insert into waitlist (id,email) values (${newId()},${email}) on conflict (email) do nothing`
  } finally {
    await sql.end()
  }
}

/** 管理员后台幂等补发测试积分（staging 无支付、无注册赠送时唯一的产品入口）。 */
async function adminCredits(page: Page, workspaceId: string) {
  const id = sqlLiteral(workspaceId)
  const [balance] = await query<{ available: number }>(`select coalesce(sum(remaining),0)::float8
    as available from credit_grant where workspace_id=${id} and status='active'
    and (expires_at is null or expires_at>now())`)
  const reason = `harden deletion test credits ${runId}`
  const browser = page.context().browser()
  if (!browser) throw new Error('Missing browser')
  const context = await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
  try {
    const adminPage = await context.newPage()
    await login(adminPage, 'admin')
    adminIdentity(await sessionUser(adminPage))
    await adminPage.goto(`/admin/credits?workspaceId=${workspaceId}`)
    await ensureAcceptanceCredits(
      adminPage,
      () =>
        query<{ id: string }>(`select id from audit_log where workspace_id=${id}
          and action='credits.adjust' and meta->'input'->>'kind'='grant'
          and meta->'input'->>'reason'=${sqlLiteral(reason)} order by id`),
      balance?.available ?? 0,
      reason,
    )
  } finally {
    await context.close()
  }
}

/** 经对话页 UI 发一条按次计费消息并等待完成；返回对话 ID。 */
async function chatOnce(page: Page, slug: string, label: string) {
  await page.goto(`/app/${slug}/chat`)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
  const conversationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  await expect
    .poll(
      async () => {
        await page.reload()
        return page.getByLabel('Model', { exact: true }).locator('option[value]').allTextContents()
      },
      { timeout: 90_000, intervals: [2_000, 5_000] },
    )
    .toContain(deepseekCall.key)
  await page.getByLabel('Model', { exact: true }).selectOption({ label: deepseekCall.key })
  await page
    .getByLabel('Message', { exact: true })
    .fill(`Harden deletion acceptance ${label}. Reply with one short sentence.`)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await query<{ status: string }>(`select status from ai_message
            where conversation_id=${sqlLiteral(conversationId)} and role='assistant'`)
        )[0]?.status,
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe('completed')
  return conversationId
}

async function mediaOnce(page: Page, workspaceId: string, userId: string, step: string) {
  const submitted = await reuseOrSubmit(page, { workspaceId, userId }, workersImage, step)
  const task = await awaitTerminal(page, workspaceId, submitted.taskId)
  // Workers AI 偶发 8007 误判也会产生终态任务与失败通知，对本场景同样有效。
  expect(['succeeded', 'failed']).toContain(task.status)
  return task.id
}

async function content(workspaceId: string, userId: string): Promise<Counts> {
  const w = sqlLiteral(workspaceId)
  const u = sqlLiteral(userId)
  const [row] = await query<Counts>(`select
    (select count(*)::int from ai_conversation where workspace_id=${w} and user_id=${u}) as conversations,
    (select count(*)::int from ai_message m join ai_conversation c on c.id=m.conversation_id
      where c.workspace_id=${w} and c.user_id=${u}) as messages,
    (select count(*)::int from ai_task where workspace_id=${w} and user_id=${u}) as tasks`)
  if (!row) throw new Error('Missing content counts')
  return row
}

/** A 在团队空间的对话与消息：比较 ID 与更新时间摘要，任何删除或改写都会改变它。 */
async function contentDigest(workspaceId: string, userId: string) {
  const [row] = await query<{ digest: string }>(`select md5(coalesce(string_agg(
      c.id::text||':'||m.id::text||':'||m.updated_at::text, ',' order by m.id), '')) as digest
    from ai_conversation c join ai_message m on m.conversation_id=c.id
    where c.workspace_id=${sqlLiteral(workspaceId)} and c.user_id=${sqlLiteral(userId)}`)
  return row?.digest ?? ''
}

async function fileDigest(workspaceId: string) {
  const [row] = await query<{ digest: string }>(`select md5(coalesce(string_agg(
      id::text||':'||status||':'||coalesce(deleted_at::text,''), ',' order by id), '')) as digest
    from file where workspace_id=${sqlLiteral(workspaceId)}`)
  return row?.digest ?? ''
}

/** 财务表逐表整行摘要（credit_debt 没有 id 列，按整行文本排序）；清理任务不得改动这些行。 */
async function financeDigest(workspaceIds: string[]) {
  const ids = workspaceIds.map(sqlLiteral).join(',')
  const digests: Record<string, string> = {}
  for (const table of FINANCE_TABLES) {
    const [row] = await query<{ digest: string; rows: number }>(`select
      md5(coalesce(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text), '')) as digest,
      count(*)::int as rows from ${table} t where t.workspace_id in (${ids})`)
    digests[table] = `${row?.rows ?? 0}:${row?.digest ?? ''}`
  }
  return digests
}

/**
 * 删号时 billing 删除步骤会取消个人空间订阅并收回剩余积分（packages/billing/src/deletion.ts），
 * 因此个人空间的财务行允许被更新或追加，但删号前的每一行都必须仍然存在，且积分流水原有行不变。
 */
async function financeRows(workspaceId: string) {
  const w = sqlLiteral(workspaceId)
  const rows: Record<string, string[]> = {}
  for (const table of FINANCE_TABLES) {
    const key = table === 'credit_debt' ? 'md5(row_to_json(t)::text)' : 't.id::text'
    rows[table] = (
      await query<{ key: string }>(`select ${key} as key from ${table} t where t.workspace_id=${w}`)
    ).map((row) => row.key)
  }
  const [ledger] = await query<{ digest: string }>(`select md5(coalesce(string_agg(
      row_to_json(t)::text, ',' order by t.id), '')) as digest from credit_ledger t
    where t.workspace_id=${w} and t.id::text in (${(rows.credit_ledger ?? []).map(sqlLiteral).join(',') || 'null'})`)
  return { rows, ledger: ledger?.digest ?? '' }
}

async function expectFinanceRetained(
  workspaceId: string,
  before: Awaited<ReturnType<typeof financeRows>>,
) {
  const after = await financeRows(workspaceId)
  for (const table of FINANCE_TABLES) {
    if (table === 'credit_debt')
      expect((after.rows[table] ?? []).length).toBeGreaterThanOrEqual(
        (before.rows[table] ?? []).length,
      )
    else
      expect(after.rows[table], `${table} rows retained`).toEqual(
        expect.arrayContaining(before.rows[table] ?? []),
      )
  }
  const [ledger] = await query<{ digest: string }>(`select md5(coalesce(string_agg(
      row_to_json(t)::text, ',' order by t.id), '')) as digest from credit_ledger t
    where t.workspace_id=${sqlLiteral(workspaceId)}
    and t.id::text in (${(before.rows.credit_ledger ?? []).map(sqlLiteral).join(',') || 'null'})`)
  expect(ledger?.digest, 'Existing credit ledger rows are unchanged').toBe(before.ledger)
  return Object.fromEntries(
    FINANCE_TABLES.map((table) => [
      table,
      { before: (before.rows[table] ?? []).length, after: (after.rows[table] ?? []).length },
    ]),
  )
}

function nextCleanup(after: Date) {
  const next = new Date(after)
  next.setUTCHours(CLEANUP_HOUR_UTC, 0, 0, 0)
  if (next <= after) next.setUTCDate(next.getUTCDate() + 1)
  return next
}

async function confirmAccountDeletion(page: Page) {
  await page.goto('/account')
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  const button = page.getByRole('button', { name: 'Delete account', exact: true })
  await expect(button).toBeDisabled()
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page).toHaveURL(/\/login$/)
}

test('删号：个人空间进入保留期，增长名单与通知立即删除，审计无个人信息，财务记录保留', async ({
  page,
  browser,
}) => {
  test.setTimeout(30 * 60_000)
  requireEnv(['STAGING_URL', 'NEON_READONLY_URL'])
  requireHeadedForStaging()
  const saved = await readEvidenceAnyDate<DeletionState>('harden-deletion-state')
  test.skip(Boolean(saved), '该 runId 已完成删号；继续运行清理检查用例')

  // 本地团队空间由夹具创建；staging 模板 multiTenant 关闭，产品没有创建/邀请入口。
  const withTeam = local
  const contextA = withTeam
    ? await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
    : null
  try {
    const b = await register(page, 'b')
    const pageA = contextA ? await contextA.newPage() : null
    const a = pageA ? await register(pageA, 'a') : null
    const team = a ? await seedLocalTeam(a.userId, b.userId) : null
    if (local) {
      await seedLocalWorkspace(b.personal.id)
      if (team) await seedLocalWorkspace(team.id)
      await seedLocalGrowth(accounts.b.email)
    } else await adminCredits(page, b.personal.id)

    // B：个人空间与团队空间各一条对话 + 一个媒体任务；A：团队空间一条对话。
    await chatOnce(page, b.personal.slug, 'b-personal')
    await mediaOnce(page, b.personal.id, b.userId, `harden-del-${tag}-b-personal`)
    if (team && pageA && a) {
      await chatOnce(page, team.slug, 'b-team')
      await mediaOnce(page, team.id, b.userId, `harden-del-${tag}-b-team`)
      await chatOnce(pageA, team.slug, 'a-team')
      await convertLocalTeam(team.id)
    }

    const b0 = sqlLiteral(b.userId)
    const growthBefore = await query<{
      newsletter: number
      waitlist: number
      notifications: number
    }>(
      `select
        (select count(*)::int from newsletter_subscriber where email=${sqlLiteral(accounts.b.email)}) as newsletter,
        (select count(*)::int from waitlist where email=${sqlLiteral(accounts.b.email)}) as waitlist,
        (select count(*)::int from notification where user_id=${b0}) as notifications`,
    )
    const before = growthBefore[0]
    if (!before) throw new Error('Missing growth snapshot')
    // 媒体任务终态写入站内通知（packages/ai/src/media/tasks.ts）。
    expect(before.notifications, 'B must own notifications before deletion').toBeGreaterThan(0)
    if (local) {
      expect(before.newsletter).toBe(1)
      expect(before.waitlist).toBe(1)
    }
    const personalContent = await content(b.personal.id, b.userId)
    expect(personalContent).toEqual({ conversations: 1, messages: 2, tasks: 1 })
    const teamContentB = team ? await content(team.id, b.userId) : null
    if (team) expect(teamContentB).toEqual({ conversations: 1, messages: 2, tasks: 1 })
    const teamContentA = team && a ? await contentDigest(team.id, a.userId) : null
    const teamFiles = team ? await fileDigest(team.id) : null
    const workspaceIds = [b.personal.id, ...(team ? [team.id] : [])]
    const personalFinance = await financeRows(b.personal.id)
    const teamFinance = team ? await financeDigest([team.id]) : null

    // 删号要求 10 分钟内的新登录；staging 生成较慢时重新登录（需要人完成 Turnstile）。
    if (Date.now() - (sessions.get('b') ?? 0) > FRESH_SESSION_MS) await passwordLogin(page, 'b')
    await confirmAccountDeletion(page)

    const [user] = await query<{ email: string; name: string; banned: boolean }>(
      `select email, name, banned from "user" where id=${b0}`,
    )
    expect(user?.email).toBe(`deleted+${b.userId}@invalid`)
    expect(user?.name).toBe('')
    expect(user?.banned).toBe(true)
    const [workspace] = await query<{ deleted: boolean; recent: boolean; deletedAt: string }>(
      `select deleted_at is not null as deleted, deleted_at > now() - interval '30 minutes' as recent,
        deleted_at as "deletedAt" from organization where id=${sqlLiteral(b.personal.id)}`,
    )
    expect(workspace?.deleted, 'Personal workspace enters retention').toBe(true)
    expect(workspace?.recent).toBe(true)
    // 保留期内个人空间内容不删除，等保留期结束由 cleanupExpiredWorkspaces 处理。
    expect(await content(b.personal.id, b.userId)).toEqual(personalContent)
    const [growthAfter] = await query<{
      newsletter: number
      waitlist: number
      notifications: number
    }>(
      `select
        (select count(*)::int from newsletter_subscriber where email=${sqlLiteral(accounts.b.email)}) as newsletter,
        (select count(*)::int from waitlist where email=${sqlLiteral(accounts.b.email)}) as waitlist,
        (select count(*)::int from notification where user_id=${b0}) as notifications`,
    )
    expect(growthAfter).toEqual({ newsletter: 0, waitlist: 0, notifications: 0 })
    // 审计只追加：检查所有指向 B 的记录元数据中不含原邮箱与姓名。
    const [audit] = await query<{ total: number; leaking: number }>(`select count(*)::int as total,
      count(*) filter (where position(${sqlLiteral(accounts.b.email)} in lower(meta::text)) > 0
        or position(${sqlLiteral(accounts.b.name.toLowerCase())} in lower(meta::text)) > 0)::int as leaking
      from audit_log where actor_user_id=${b0} or target_id=${b0}
        or meta::text like ${sqlLiteral(`%${b.userId}%`)}`)
    expect(audit?.total, 'Audit rows referencing B').toBeGreaterThan(0)
    expect(audit?.leaking, 'Audit metadata must not contain B email or name').toBe(0)
    const personalFinanceChange = await expectFinanceRetained(b.personal.id, personalFinance)
    if (team) expect(await financeDigest([team.id]), 'Team finance unchanged').toEqual(teamFinance)
    const finance = await financeDigest(workspaceIds)
    if (team && a) {
      expect(await contentDigest(team.id, a.userId)).toBe(teamContentA)
      // 团队空间中 B 的内容由每日 cron 分批删除，删号事务本身不动它们。
      expect(await content(team.id, b.userId)).toEqual(teamContentB)
    }

    const state: DeletionState = {
      userA: a?.userId ?? null,
      userB: b.userId,
      personal: b.personal,
      team,
      deletedAt: workspace?.deletedAt ?? new Date().toISOString(),
      personalContent,
      teamContentB,
      teamContentA,
      teamFiles,
      finance,
    }
    await evidence('harden-deletion-state', state)
    await evidence('harden-deletion-immediate', {
      outcome: 'passed',
      userB: b.userId,
      personalWorkspaceId: b.personal.id,
      teamWorkspaceId: team?.id ?? null,
      anonymized: true,
      personalRetention: { deleted: true, contentKept: personalContent },
      growthBefore: before,
      growthAfter,
      growthSource: local ? 'local-fixture' : 'features-disabled-on-staging',
      audit,
      personalFinanceRetained: personalFinanceChange,
      teamFinanceUnchanged: team ? true : null,
      teamContentUntilCron: teamContentB,
    })
  } finally {
    await contextA?.close()
  }
})

test('删号后 newsletter 与 waitlist 中的邮箱记录已删除', async () => {
  requireEnv(['STAGING_URL', 'NEON_READONLY_URL'])
  const immediate = await readEvidenceAnyDate<{
    growthBefore: { newsletter: number; waitlist: number }
    growthAfter: { newsletter: number; waitlist: number }
  }>('harden-deletion-immediate')
  if (!immediate) throw new Error('[验收准备] 缺少删号证据，请先运行删号用例')
  if (!local) {
    await unconfirmed(
      'harden-deletion-growth',
      `staging 模板 features.newsletter=${templateConfig.features.newsletter}、features.waitlist=${templateConfig.features.waitlist}，无法经产品写入增长名单；删除逻辑由本地结果与 ai-content-cleanup.test.ts 覆盖`,
    )
    return
  }
  // 本地记录由隔离库夹具写入（模板同样关闭这两项功能），删除由真实删号接口完成。
  expect(immediate.growthBefore).toMatchObject({ newsletter: 1, waitlist: 1 })
  expect(immediate.growthAfter).toMatchObject({ newsletter: 0, waitlist: 0 })
  await evidence('harden-deletion-growth', {
    outcome: 'passed',
    source: 'local-fixture',
    ...immediate,
  })
})

test('删号后清理任务：团队空间中 B 的对话、消息与媒体任务被删除，A 与财务不变', async () => {
  test.setTimeout(30 * 60_000)
  requireEnv(['STAGING_URL', 'NEON_READONLY_URL'])
  const state = await readEvidenceAnyDate<DeletionState>('harden-deletion-state')
  if (!state) throw new Error('[验收准备] 缺少删号证据，请先运行删号用例')
  if (!state.team || !state.userA || !state.teamContentB) {
    await unconfirmed(
      'harden-deletion-team-cleanup',
      `staging 模板 tenancy.multiTenant=${templateConfig.tenancy.multiTenant}，无法经产品创建团队空间与邀请成员；团队清理见本地结果与 Postgres 集成测试`,
    )
    return
  }
  const team = state.team
  if (local) {
    // 本地直接执行 jobs 的每日清理入口，与 staging cron 调用同一函数。
    const { runWorkspaceCleanup } = await import('../../../jobs/src/cron/workspace-cleanup.ts')
    const worktree = loadEnv('worktree', new URL('../../../../', import.meta.url).pathname, '')
    const db = createDb({ connectionString: worktree.DATABASE_URL ?? '' })
    try {
      await runWorkspaceCleanup({ db: { business: () => db } as never })
    } finally {
      await db.$client.end()
    }
  } else {
    const due = nextCleanup(new Date(state.deletedAt)).getTime() + CLEANUP_GRACE_MS
    const wait = Number(process.env.HARDEN_DELETION_CRON_WAIT_MS ?? 0)
    if (Date.now() + wait < due) {
      await unconfirmed(
        'harden-deletion-team-cleanup',
        `清理 cron 尚未到期，请在 ${new Date(due).toISOString()} 之后用同一 runId 重跑本用例`,
        { dueAt: new Date(due).toISOString() },
      )
      return
    }
  }
  const deadline = local
    ? 30_000
    : Math.max(60_000, Number(process.env.HARDEN_DELETION_CRON_WAIT_MS ?? 0))
  await expect
    .poll(async () => content(team.id, state.userB), {
      timeout: deadline,
      intervals: [5_000, 30_000],
    })
    .toEqual({ conversations: 0, messages: 0, tasks: 0 })
  expect(await contentDigest(team.id, state.userA)).toBe(state.teamContentA)
  // 团队空间共享产出文件保留，只解除 source_task_id 引用。
  expect(await fileDigest(team.id)).toBe(state.teamFiles)
  const [orphans] = await query<{ count: number }>(`select count(*)::int as count from file f
    where f.workspace_id=${sqlLiteral(team.id)} and f.source_task_id is not null
    and not exists(select 1 from ai_task t where t.id=f.source_task_id)`)
  expect(orphans?.count).toBe(0)
  // 个人空间仍在保留期内，内容不受删号用户清理影响。
  expect(await content(state.personal.id, state.userB)).toEqual(state.personalContent)
  expect(await financeDigest([state.personal.id, team.id])).toEqual(state.finance)
  await evidence('harden-deletion-team-cleanup', {
    outcome: 'passed',
    trigger: local ? 'local-direct-runWorkspaceCleanup' : 'staging-cron',
    teamWorkspaceId: team.id,
    teamContentBefore: state.teamContentB,
    teamContentAfter: { conversations: 0, messages: 0, tasks: 0 },
    otherMemberUnchanged: true,
    sharedFilesKept: true,
    personalRetentionContent: state.personalContent,
    financeUnchanged: true,
  })
})

test('空间保留期结束后的永久删除：由 Postgres 集成测试覆盖', async () => {
  await unconfirmed(
    'harden-deletion-retention-expiry',
    '保留期 30 天无法在验收中等待；由 packages/auth/test/ai-content-cleanup.test.ts 与 workspace-lifecycle.test.ts 覆盖',
    {
      coveredBy: [
        'AI content deletion in workerd > purges an expired workspace in batches, keeps held rows until settled and finance intact',
        'AI content deletion in workerd > keeps AI content of a soft-deleted workspace inside the retention period',
        'workspace lifecycle in workerd > cleans expired content once, preserves anchors and permanently prevents restore',
      ],
    },
  )
})
