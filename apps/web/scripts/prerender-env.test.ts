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

  it('示例中值为空的 *_SECRET / *_TOKEN 随机生成，其余保留示例值', () => {
    vi.stubEnv('APP_URL', '')
    const vars = fallbackDevVars(root({ '.dev.vars.example': example })) ?? ''
    expect(vars).toMatch(/^BETTER_AUTH_SECRET=\S{40,}$/m)
    expect(vars).toMatch(/^SITE_TOKEN=\S{40,}$/m)
    expect(vars).toContain('GOOGLE_CLIENT_SECRET=fake\n')
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
})
