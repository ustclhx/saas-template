import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adminActions } from '../actions.registry.ts'

// add-admin-step-up tasks 4.2：重新验证强制开启后，后台界面上每个敏感写操作的调用点都必须经
// useStepUpCall，否则管理员在没有弹窗的入口上只会看到失败。静态扫描两件事：
// 1. 处理敏感动作的 Server Function（POST，定义中出现敏感动作名）都在下表中；
// 2. 界面代码只以 `useStepUpCall(<函数>` 的形式使用它们，没有直接调用。

const ROOT = join(import.meta.dirname, '../../../../../..')
const plugins = readdirSync(join(ROOT, 'plugins'))
const SERVER_DIRS = ['apps/web/src', ...plugins.map((plugin) => `plugins/${plugin}/src`)]
const UI_DIRS = [
  'apps/web/src',
  ...plugins.flatMap((plugin) => [`plugins/${plugin}/src`, `plugins/${plugin}/routes`]),
]

/** 处理敏感动作、并在后台界面中调用的 Server Function */
const SENSITIVE_SERVER_FUNCTIONS = [
  'setAdminUserBan',
  'startAdminImpersonation',
  'adjustCredits',
  'replayAdminWebhook',
  'reviewAdminRefund',
  'completeAdminRefund',
  'saveOperationsSettings',
  'saveAdminSettings',
  'saveAdminFeatureModels',
  'saveAdminModel',
  'saveAdminPlanModels',
  'createAdminApiTokenFn',
  'confirmAdminConfirmation',
]

/**
 * 动作名不在 Server Function 定义块内、而由其调用的服务函数给出的项（扫描读不到，在此说明来源）：
 * 封禁 / 模拟登录经 impersonation.server.ts 的 executeAdminAuthAction，确认执行经
 * confirmations/service.ts 的 confirmPendingAction（admin.confirmation.confirm）。
 */
const INDIRECT = new Set(['setAdminUserBan', 'startAdminImpersonation', 'confirmAdminConfirmation'])

function files(dir: string, pattern: RegExp): string[] {
  const absolute = join(ROOT, dir)
  try {
    statSync(absolute)
  } catch {
    return []
  }
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((file) => pattern.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => !file.split(sep).includes('paraglide') && !file.endsWith('.gen.ts'))
    .map((file) => relative(ROOT, join(absolute, file)).split(sep).join('/'))
}

/** 插件经 defineAdminActions 追加的登记（按源码文本读取，测试不加载插件模块） */
function pluginSensitiveNames(): string[] {
  const names: string[] = []
  for (const file of plugins.flatMap((plugin) => files(`plugins/${plugin}/src`, /\.ts$/))) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    if (!source.includes('defineAdminActions(')) continue
    for (const match of source.matchAll(/'([\w.]+)':\s*\{\s*stepUp:\s*([^,}]+)/g))
      if (match[1] && match[2]?.trim() !== "'never'") names.push(match[1])
  }
  return names
}

const sensitiveNames = [
  ...Object.entries(adminActions as Record<string, { readonly stepUp: unknown }>)
    .filter(([, entry]) => entry.stepUp !== 'never')
    .map(([name]) => name),
  ...pluginSensitiveNames(),
]

/** 每个 `export const X = createServerFn({ method: 'POST' })` 定义块中出现的敏感动作名 */
function sensitiveServerFunctions(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of SERVER_DIRS.flatMap((dir) => files(dir, /\.ts$/))) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const chunk of source.split(/\nexport const /).slice(1)) {
      const match = /^(\w+) = createServerFn\(\{ method: 'POST' \}\)/.exec(chunk)
      if (!match?.[1]) continue
      const names = sensitiveNames.filter((name) => chunk.includes(`'${name}'`))
      if (names.length) found.set(match[1], names)
    }
  }
  return found
}

describe('后台敏感写操作的界面调用点', () => {
  it('处理敏感动作的 Server Function 都已列入', () => {
    expect(sensitiveNames).toContain('admin.api_token.create')
    const found = new Set([...sensitiveServerFunctions().keys(), ...INDIRECT])
    expect([...found].sort()).toEqual([...SENSITIVE_SERVER_FUNCTIONS].sort())
  })

  it('界面只经 useStepUpCall 调用它们，且每个都有界面入口', () => {
    const wrapped = new Set<string>()
    const direct: string[] = []
    for (const file of UI_DIRS.flatMap((dir) => files(dir, /\.tsx$/))) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const name of SENSITIVE_SERVER_FUNCTIONS) {
        if (new RegExp(`useStepUpCall\\(${name}\\b`).test(source)) wrapped.add(name)
        if (new RegExp(`(?<!useStepUpCall\\()\\b${name}\\(`).test(source))
          direct.push(`${file}: ${name}`)
      }
    }
    expect(direct).toEqual([])
    expect([...wrapped].sort()).toEqual([...SENSITIVE_SERVER_FUNCTIONS].sort())
  })
})
