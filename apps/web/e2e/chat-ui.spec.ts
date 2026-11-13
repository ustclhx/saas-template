import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@saas/shared'
import {
  chooseSeededModel,
  newConversation,
  removeModel,
  seedChatModel,
  slugOf,
} from './chat-fixtures.ts'
import { register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 对话页切换到 @saas/ui/chat 组件（openspec add-ai-chat-components tasks 4.5）：Markdown 表格与代码块、
// 代码复制、停止后显示已停止、390px 无横向滚动，浅色与深色截图（与 chat-components/Main、Mobile 副本对照）。
// 本地没有真实模型：页面的 fetch 被替换为可控的 UI message 流；选择器只用结构与 data 属性，不依赖界面语言。

const evidenceDir = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'add-ai-chat-components',
)

const LONG_LINE = `rows = [${Array.from({ length: 40 }, (_, i) => `"channel-${i}"`).join(', ')}]`
const CODE = [
  'def cac(spend: dict[str, float], new_users: dict[str, int]) -> dict[str, float]:',
  '    # 新客为 0 的渠道不计算，避免除零',
  '    return {ch: round(spend[ch] / n, 1) for ch, n in new_users.items() if n > 0}',
  LONG_LINE,
].join('\n')
const REPLY = [
  'Customer acquisition cost by channel last quarter:',
  '',
  '| Channel | New users | Spend | CAC | QoQ |',
  '|---|---|---|---|---|',
  '| Search ads | 1,240 | 186,000 | 150 | −8% |',
  '| Content partners | 860 | 98,900 | 115 | +3% |',
  '| Offline events | 310 | 74,400 | 240 | +21% |',
  '',
  'The calculation, with `spend` and `new_users` summed per channel:',
  '',
  '```python',
  CODE,
  '```',
  '',
  '- Content partners have the lowest CAC and room to grow;',
  '- Offline events vary the most.',
  '',
  'See [report §3.2](https://example.com/report).',
].join('\n')

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
})

/**
 * 替换页面的 fetch：第 1 次对话请求按块流出 `reply` 后结束；之后的请求只发出一段正文并保持打开，
 * 直到被中止（模拟生成中）。
 */
async function fakeModel(page: Page, messageIds: string[], reply: string) {
  await page.addInitScript(
    ({ messageIds, reply }) => {
      const original = window.fetch
      let calls = 0
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.endsWith('/api/ai/chat')) return original(input, init)
        const encoder = new TextEncoder()
        const line = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        const body = JSON.parse(String(init?.body)) as { conversationId: string }
        const call = calls++
        const messageId = messageIds[call] ?? messageIds[0]
        const stream = new ReadableStream({
          async start(controller) {
            const metadata = { conversationId: body.conversationId, messageId }
            controller.enqueue(line({ type: 'start', messageId, messageMetadata: metadata }))
            controller.enqueue(line({ type: 'start-step' }))
            controller.enqueue(line({ type: 'text-start', id: 't1' }))
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            )
            if (call > 0) {
              controller.enqueue(line({ type: 'text-delta', id: 't1', delta: 'Partial answer' }))
              return
            }
            for (let i = 0; i < reply.length; i += 40) {
              controller.enqueue(
                line({ type: 'text-delta', id: 't1', delta: reply.slice(i, i + 40) }),
              )
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
            controller.enqueue(line({ type: 'text-end', id: 't1' }))
            controller.enqueue(line({ type: 'finish-step' }))
            controller.enqueue(line({ type: 'finish' }))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return Promise.resolve(
          new Response(stream, {
            headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
          }),
        )
      }
    },
    { messageIds, reply },
  )
}

async function noHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(390)
}

async function shoot(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true })
  // 等入场动效与光标结束后再截图
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), animations: 'disabled' })
}

test('chat page renders Markdown replies, copies code, stops and fits 390px (4.5)', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await register(page, `chat-ui-${randomUUID()}@example.com`)
  const slug = slugOf(page)
  const model = await seedChatModel(slug)
  const messageIds = [newId(), newId()]
  const stops: string[] = []
  await page.route('**/api/ai/chat/*/stop', async (route) => {
    stops.push(new URL(route.request().url()).pathname)
    await route.fulfill({ status: 200, json: { status: 'aborted' } })
  })
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: 'light' })
    await newConversation(page, slug)
    await fakeModel(page, messageIds, REPLY)
    await chooseSeededModel(page, model.modelId)

    const input = page.locator('#chat-input')
    await expect(input).toBeEnabled({ timeout: 30_000 })
    // 空态：输入区贴在底部（Main.dc.html 的 empty）
    await shoot(page, 'chat-page-empty-desktop-light')
    await input.fill('Put last quarter CAC by channel in a table, with sample code.')
    await input.press('Enter')

    const replies = page.locator('li[data-role="assistant"]')
    const first = replies.first()
    // Markdown：表格与代码块
    await expect(first.locator('table tbody tr')).toHaveCount(3)
    const code = first.locator('[data-chat-code]')
    await expect(code.locator('pre')).toContainText('def cac(')
    await expect(first.locator('a[href="https://example.com/report"]')).toHaveAttribute(
      'rel',
      /noopener/,
    )
    // 生成结束：输入区换回发送，回复下方有操作区
    await expect(page.locator('[data-action="send"]')).toBeVisible()
    await expect(first.locator('[data-chat-actions]')).toBeVisible()

    // 代码块复制：剪贴板得到代码原文（不含语言名）
    await code.locator('button').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(CODE)

    await shoot(page, 'chat-page-desktop-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await shoot(page, 'chat-page-desktop-dark')

    // 390px：页面没有横向滚动，长代码行只在代码块内滚动
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    await noHorizontalScroll(page)
    // 代码块的滚动区域可聚焦（键盘可滚动）
    const overflow = await code
      .locator('[tabindex="0"]')
      .evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(overflow).toBe(true)
    await shoot(page, 'chat-page-390-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'chat-page-390-dark')
    await page.emulateMedia({ colorScheme: 'light' })

    // 停止：保留已生成的正文并显示已停止，输入区换回发送
    await input.fill('And the budget?')
    await input.press('Enter')
    const second = replies.nth(1)
    await expect(second).toContainText('Partial answer')
    await page.locator('[data-action="stop"]').click()
    await expect.poll(() => stops).toEqual([`/api/ai/chat/${messageIds[1]}/stop`])
    await expect(second.locator('[data-chat-status="aborted"]')).toBeVisible()
    await expect(second).toContainText('Partial answer')
    await expect(page.locator('[data-action="send"]')).toBeVisible()
    await noHorizontalScroll(page)
  } finally {
    await removeModel(model.modelId)
  }
})
