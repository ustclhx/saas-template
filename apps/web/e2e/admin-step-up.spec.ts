import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { fulfillWithStripeAvailable, requestData } from './billing-actions-helper.ts'
import {
  authEmailCount,
  fixtureDb,
  PASSWORD,
  register,
  simulateClientIp,
  stepUpCode,
} from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// openspec add-admin-step-up 任务 4.2 / 4.3：敏感后台操作被要求重新验证时当场弹窗，
// 通过后用原参数自动继续；AI 经 MCP 发起的敏感操作由管理员在确认页验证后执行。

type Sql = ReturnType<typeof fixtureDb>

/** 后台布局的退出按钮在水合后才可用：此前的点击落在未接管的元素上 */
const hydrated = (page: Page) =>
  expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled({ timeout: 30_000 })

async function makeAdmin(page: Page, sql: Sql, prefix: string) {
  const email = `${prefix}-${randomUUID()}@example.com`
  await simulateClientIp(page)
  await stubTurnstile(page)
  await register(page, email)
  const [account] = await sql`select id from "user" where email=${email}`
  const [workspace] =
    await sql`select o.id, o.name from member m join organization o on o.id=m.organization_id
      where m.user_id=${account?.id} and m.role='owner' limit 1`
  if (!account || !workspace) throw new Error('Missing admin fixture')
  await sql`update "user" set role='admin' where id=${account.id}`
  return {
    email,
    userId: String(account.id),
    workspace: { id: String(workspace.id), name: String(workspace.name) },
  }
}

/** Real stripe rows offline: only the provider readiness flag of refund rows is flipped */
async function markStripeAvailable(page: Page) {
  const posts: Record<string, unknown>[] = []
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(requestData(route))
      await route.continue()
      return
    }
    // 只有退款与价格目录行的 Stripe 可用标记被改写，其余为真实响应
    await fulfillWithStripeAvailable(route)
  })
  return posts
}

test('部分退款：填写金额后被要求验证，邮箱验证码通过后按原金额自动提交', async ({ page }) => {
  const sql = fixtureDb()
  const plan = randomUUID()
  const price = randomUUID()
  try {
    const admin = await makeAdmin(page, sql, 'step-up-refund')
    // 邮箱验证码只发往已验证邮箱：本例走邮箱验证码，另一例（未验证邮箱）只有密码
    await sql`update "user" set email_verified=true where id=${admin.userId}`
    const purchase = randomUUID()
    const payment = randomUUID()
    const requestId = randomUUID()
    await sql`insert into plan(id,key,name,type,credits,features) values(${plan},${plan},'Step-up fixture','credit_pack',100,'{"models":[],"maxConcurrentTasks":1,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":true}'::jsonb)`
    await sql`insert into plan_price(id,plan_id,provider,provider_price_id,amount,currency) values(${price},${plan},'stripe',${price},1234,'USD')`
    await sql`insert into purchase(id,workspace_id,user_id,plan_id,plan_price_id,provider,provider_order_id,status,amount,currency) values(${purchase},${admin.workspace.id},${admin.userId},${plan},${price},'stripe',${purchase},'paid',1234,'USD')`
    await sql`insert into payment(id,workspace_id,provider,provider_payment_id,purchase_id,kind,amount,currency,paid_at) values(${payment},${admin.workspace.id},'stripe',${payment},${purchase},'one_time',1234,'USD',now())`
    await sql`insert into refund_request(id,workspace_id,user_id,payment_id,reason,contact_email,requested_amount) values(${requestId},${admin.workspace.id},${admin.userId},${payment},'Step-up refund',${admin.email},500)`

    const posts = await markStripeAvailable(page)
    // 客户端导航进入：页面数据经 Server Function 读取，服务端渲染不被替换
    await page.goto('/admin')
    await hydrated(page)
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Refund reviews', exact: true })
      .click()
    const card = page.getByRole('article', { name: `Refund ${requestId}` })
    await expect(card.getByRole('button', { name: 'Approve full refund' })).toBeEnabled()
    await card.getByLabel('Review note').fill('Partial refund after step-up')
    await card.getByLabel('Partial amount (USD cents)').fill('321')
    await card.getByRole('button', { name: 'Approve partial refund' }).click()

    const dialog = page.getByRole('dialog', { name: "Confirm it's you" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'Email code' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const before = authEmailCount()
    await dialog.getByRole('button', { name: 'Send code' }).click()
    await expect(dialog.getByText(/^Sent to /)).toBeVisible()
    await dialog.getByLabel('Email code').fill(await stepUpCode(admin.email, before))
    await dialog.getByRole('button', { name: 'Verify and continue' }).click()
    await expect(dialog).toHaveCount(0)

    // 被拒的那次与验证后自动重试的那次参数完全相同，金额与备注为填写的值
    const reviews = posts.filter((data) => data.requestId === requestId)
    expect(reviews).toHaveLength(2)
    expect(reviews[1]).toEqual(reviews[0])
    expect(reviews[1]).toMatchObject({
      requestId,
      decision: 'approve',
      approvedAmount: 321,
      reviewNote: 'Partial refund after step-up',
    })
    // 离线环境没有支付平台：重试越过了重新验证，止于退款服务的平台检查
    await expect(card).toContainText('BILLING_UNAVAILABLE')
    await expect(card.getByLabel('Partial amount (USD cents)')).toHaveValue('321')
    const [verified] =
      await sql`select meta->>'method' as method from audit_log where actor_user_id=${admin.userId} and action='admin.step_up.verified'`
    expect(verified?.method).toBe('email_otp')
    await expect(
      page.getByRole('status').filter({ hasText: /^Verified, \d+ min left$/ }),
    ).toBeVisible()
  } finally {
    // 测试结束时仍在途的 GET 会让 route.fetch 抛「Test ended」，先撤掉拦截
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await sql`update plan set active=false where id=${plan}`
    await sql`update plan_price set active=false where id=${price}`
    await sql.end()
  }
})

async function issueToken(sql: Sql, userId: string) {
  const token = `xat_${randomBytes(32).toString('base64url')}`
  await sql`insert into admin_api_token(id,user_id,name,prefix,token_hash,scopes,expires_at)
    values(${randomUUID()},${userId},'E2E agent',${token.slice(0, 12)},
      ${createHash('sha256').update(token).digest('hex')},${['admin:read', 'admin:write']},now()+interval '1 day')`
  return token
}

async function mcpCall(request: APIRequestContext, token: string, name: string, args: unknown) {
  const response = await request.post('/api/admin/mcp', {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> }
  }
  expect(body.result.isError).toBeFalsy()
  return body.result.structuredContent
}

test('MCP 发起积分调整：打开确认链接、验证后确认，余额变化且查询结果为 done', async ({
  page,
  request,
}) => {
  const sql = fixtureDb()
  try {
    const admin = await makeAdmin(page, sql, 'step-up-confirm')
    const token = await issueToken(sql, admin.userId)
    const reason = `E2E confirm ${randomUUID()}`
    const requested = await mcpCall(request, token, 'credits.adjust', {
      workspace: admin.workspace.id,
      kind: 'grant',
      amount: 77,
      reason,
    })
    expect(requested).toMatchObject({ status: 'needs_owner_confirm' })
    const confirmationId = String(requested.confirmationId)
    const grants = () =>
      sql`select amount from credit_grant where workspace_id=${admin.workspace.id} and source='admin'`
    expect(await grants()).toHaveLength(0)

    // 导航上的待确认数量与列表
    await page.goto('/admin/confirmations')
    await expect(page.getByRole('link', { name: /^Confirmations\s*\d+$/ })).toBeVisible()
    const row = page
      .getByRole('row')
      .filter({ has: page.locator(`a[href="/admin/confirm/${confirmationId}"]`) })
    await expect(row).toContainText(`Grant 77 credits to workspace ${admin.workspace.name}`)
    await expect(row).toContainText('credits.adjust')
    await expect(row).toContainText(/\d+ min left/)

    await page.goto(new URL(String(requested.confirmUrl)).pathname)
    await expect(
      page.getByRole('heading', { name: 'Confirm an AI-requested action' }),
    ).toBeVisible()
    await expect(
      page.getByText(`Grant 77 credits to workspace ${admin.workspace.name}`),
    ).toBeVisible()
    await expect(page.getByRole('cell', { name: reason })).toBeVisible()
    // 打开确认页时的实时余额 → 执行后余额
    const balanceRow = page.getByRole('row', { name: /^Credit balance/ })
    const [{ before }] =
      (await sql`select coalesce(sum(remaining),0)::int as before from credit_grant
      where workspace_id=${admin.workspace.id} and status='active' and (expires_at is null or expires_at > now())`) as unknown as [
        { before: number },
      ]
    await expect(balanceRow.getByRole('cell')).toHaveText([
      before.toLocaleString('en-US'),
      (before + 77).toLocaleString('en-US'),
    ])
    // 发起时余额另起一行注明（本例发起后余额未变）
    await expect(
      page.getByRole('row', { name: /^Balance at request/ }).getByRole('cell'),
    ).toHaveText([before.toLocaleString('en-US')])
    await hydrated(page)
    await page.getByRole('button', { name: 'Confirm and run' }).click()

    const dialog = page.getByRole('dialog', { name: "Confirm it's you" })
    await expect(dialog).toBeVisible()
    // 邮箱未验证、有密码的账号只有密码一种方式，不显示方式切换
    await expect(dialog.getByRole('tablist')).toHaveCount(0)
    await dialog.getByLabel('Account password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Verify and continue' }).click()
    await expect(dialog).toHaveCount(0)

    await expect(page.getByText('Done.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirm and run' })).toHaveCount(0)
    expect(await grants()).toEqual([{ amount: 77 }])
    const [audit] =
      await sql`select meta->>'via' as via, meta->>'stepUpMethod' as method from audit_log
        where action='credits.adjust' and workspace_id=${admin.workspace.id}`
    expect(audit).toMatchObject({ via: 'mcp', method: 'password' })
    expect(
      await mcpCall(request, token, 'confirmations.get', { id: confirmationId }),
    ).toMatchObject({
      status: 'done',
    })
  } finally {
    await sql.end()
  }
})
