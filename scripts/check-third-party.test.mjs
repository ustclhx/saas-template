import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkDependencies, checkRegistry, checkThirdParty } from './check-third-party.mjs'

const HEADER =
  '| 第三方 | 我们自动查询 | 教使用者做的事 | 代码 / 文档位置 | 官方出处 | 上次核对 | 验证方式 |\n|---|---|---|---|---|---|---|'

function registry(...rows) {
  return `# 第三方登记表\n\n## 登记表\n\n${HEADER}\n${rows.join('\n')}\n\n## 其他\n`
}

const stripeRow =
  '| Stripe | — | 建 Webhook | `packages/billing` | [Webhooks](https://docs.stripe.com/webhooks) | 2026-11-25 | 真账号 |'

test('仓库中的登记表与依赖映射通过检查', () => {
  const root = resolve(fileURLToPath(import.meta.url), '../..')
  assert.deepEqual(checkThirdParty(root), [])
})

test('合法行通过，未核对写 —、出处可为待核实', () => {
  const { problems, names } = checkRegistry(
    registry(stripeRow, '| PostHog | — | 填 key | `apps/web` | 待核实 | — | 未核对 |'),
  )
  assert.deepEqual(problems, [])
  assert.deepEqual([...names], ['Stripe', 'PostHog'])
})

test('验证方式写成「已测试」时失败', () => {
  const { problems } = checkRegistry(registry(stripeRow.replace('真账号', '已测试')))
  assert.match(problems.join('\n'), /验证方式「已测试」不合法/)
})

test('日期写成「上周」或不存在的日期时失败', () => {
  for (const bad of ['上周', '2026-02-30', '2026/11/25']) {
    const { problems } = checkRegistry(registry(stripeRow.replace('2026-11-25', bad)))
    assert.match(problems.join('\n'), /应为 YYYY-MM-DD/, bad)
  }
})

test('未核对的行写了日期时失败', () => {
  const { problems } = checkRegistry(registry(stripeRow.replace('真账号', '未核对')))
  assert.match(problems.join('\n'), /未核对的行上次核对写 —/)
})

test('出处不是 https 链接或混入其他文字时失败', () => {
  const http = checkRegistry(registry(stripeRow.replace('https://', 'http://'))).problems
  assert.match(http.join('\n'), /必须是 https 链接/)
  const text = checkRegistry(
    registry(stripeRow.replace('[Webhooks](https://docs.stripe.com/webhooks)', '官网')),
  ).problems
  assert.match(text.join('\n'), /https 链接或「待核实」/)
  const extra = checkRegistry(registry(stripeRow.replace(')', ') 见第 3 节'))).problems
  assert.match(extra.join('\n'), /多余内容/)
})

test('列数不全、单元格为空、重复登记与表头错误时失败', () => {
  assert.match(
    checkRegistry(registry('| Stripe | — | 建 Webhook | 2026-11-25 | 真账号 |')).problems.join(
      '\n',
    ),
    /应有 7 列/,
  )
  assert.match(
    checkRegistry(registry(stripeRow.replace('建 Webhook', ''))).problems.join('\n'),
    /「教使用者做的事」不能为空/,
  )
  assert.match(checkRegistry(registry(stripeRow, stripeRow)).problems.join('\n'), /重复登记/)
  assert.match(
    checkRegistry(registry(stripeRow).replace('官方出处', '出处')).problems.join('\n'),
    /表头应为/,
  )
  assert.match(checkRegistry('# 无表\n').problems.join('\n'), /缺少「## 登记表」/)
})

function workspace(t, deps) {
  const root = mkdtempSync(join(tmpdir(), 'saas-third-party-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  mkdirSync(join(root, 'packages', 'ai'), { recursive: true })
  writeFileSync(
    join(root, 'packages', 'ai', 'package.json'),
    JSON.stringify({ name: '@saas/ai', dependencies: deps }),
  )
  return root
}

const config = {
  watch: ['^stripe$', '^@ai-sdk/'],
  packages: { stripe: 'Stripe', '@ai-sdk/openai': 'OpenAI' },
  ignore: { '@ai-sdk/react': '只提供前端 hooks' },
}

test('新增未登记的模型 Provider SDK 时失败并提示补充登记行', (t) => {
  const root = workspace(t, { '@ai-sdk/openai': '1', '@ai-sdk/mistral': '1', zod: '1' })
  const problems = checkDependencies({ root, config, names: new Set(['Stripe', 'OpenAI']) })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /packages\/ai\/package\.json: @ai-sdk\/mistral 是受监视的第三方 SDK/)
  assert.match(problems[0], /docs\/third-party\.md 登记/)
})

test('已映射或已忽略的依赖通过；映射到不存在的行与无原因的忽略失败', (t) => {
  const root = workspace(t, { stripe: '1', '@ai-sdk/react': '1' })
  assert.deepEqual(checkDependencies({ root, config, names: new Set(['Stripe', 'OpenAI']) }), [])
  const problems = checkDependencies({
    root,
    config: { ...config, ignore: { '@ai-sdk/react': ' ' } },
    names: new Set(['Stripe']),
  })
  assert.match(problems.join('\n'), /映射到「OpenAI」，但 docs\/third-party\.md 没有这一行/)
  assert.match(problems.join('\n'), /ignore 中的 @ai-sdk\/react 必须写明原因/)
})
