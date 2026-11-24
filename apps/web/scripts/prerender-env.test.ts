import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fallbackDevVars, mergeDevVars } from './prerender-env.ts'

const roots: string[] = []
function root(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'prerender-env-'))
  roots.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fallbackDevVars', () => {
  const example =
    'APP_URL=http://localhost:3000\nBETTER_AUTH_SECRET=\nSITE_TOKEN=\nGOOGLE_CLIENT_SECRET=fake\n'

  it('没有示例文件时返回 null', () => {
    expect(fallbackDevVars(root({}))).toBeNull()
  })

  it('补全预渲染需要的空认证值和密钥，保留其他示例值', () => {
    vi.stubEnv('APP_URL', '')
    const generatedExample =
      `${example}GOOGLE_CLIENT_ID=\nGITHUB_CLIENT_ID=\nTURNSTILE_SITE_KEY=\nTURNSTILE_SECRET_KEY=\n` +
      'EMAIL_FROM=\n'
    const vars = fallbackDevVars(root({ '.dev.vars.example': generatedExample })) ?? ''
    expect(vars).toMatch(/^BETTER_AUTH_SECRET=\S{40,}$/m)
    expect(vars).toMatch(/^SITE_TOKEN=\S{40,}$/m)
    expect(vars).toContain('GOOGLE_CLIENT_SECRET=fake\n')
    expect(vars).toMatch(/^GOOGLE_CLIENT_ID=\S+$/m)
    expect(vars).toMatch(/^GITHUB_CLIENT_ID=\S+$/m)
    expect(vars).toMatch(/^TURNSTILE_SITE_KEY=\S+$/m)
    expect(vars).toMatch(/^TURNSTILE_SECRET_KEY=\S+$/m)
    expect(vars).toContain('EMAIL_FROM=\n')
    expect(vars).toContain('APP_URL=http://localhost:3000\n')
  })

  it('叠加本地 .dev.vars 的项目变量，APP_URL 环境变量优先', () => {
    vi.stubEnv('APP_URL', 'https://ci.example')
    const vars =
      fallbackDevVars(
        root({ '.dev.vars.example': example, '.dev.vars': 'SITE_TOKEN=local\nPROJECT_ONLY=1\n' }),
      ) ?? ''
    expect(vars).toContain('SITE_TOKEN=local\n')
    expect(vars).toContain('PROJECT_ONLY=1\n')
    expect(vars).toContain('APP_URL=https://ci.example\n')
  })
})

describe('mergeDevVars', () => {
  it('已有键原位替换、新键追加，忽略注释与空行', () => {
    expect(mergeDevVars('# a\nA=1\nB=2', '# x\n\nB=3\nC=$4\n')).toBe('# a\nA=1\nB=3\nC=$4\n')
  })

  it('每个键仅保留最后的赋值，覆盖项优先于基础内容', () => {
    const base = 'A=first\r\nSITE_TOKEN=generated\r\n# 保留注释\r\nA=last\r\nSITE_TOKEN=old\r\n'
    const overrides = 'SITE_TOKEN=\nNEW=first\nNEW=last\n'
    expect(mergeDevVars(base, overrides)).toBe(
      'A=last\r\nSITE_TOKEN=\r\n# 保留注释\r\nNEW=last\r\n',
    )
  })
})
