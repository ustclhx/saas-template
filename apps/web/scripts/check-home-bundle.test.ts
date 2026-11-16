import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  budgetViolation,
  checkHomeBundle,
  checkServerHomeBundle,
  entryDynamicImports,
  entryScripts,
  htmlScripts,
  readPerformanceOptions,
  staticClosure,
} from './check-home-bundle.mjs'

let dir = ''

function fixture(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'home-bundle-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, '.vite'))
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content)
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('首页包检查', () => {
  it('沿静态 import 求闭包，不跟随动态 import()', () => {
    const root = fixture({
      'index.html':
        '<link rel="modulepreload" href="/assets/entry.js"><script>import("/assets/boot.js")</script>',
      'assets/entry.js': 'import{a as b}from"./route.js";import"./side.js";export*from"./re.js";',
      'assets/route.js': 'const l=()=>import("./lazy.js");',
      'assets/side.js': '',
      'assets/re.js': '',
      'assets/boot.js': '',
      'assets/lazy.js': 'const x="user-content-";',
    })
    expect(htmlScripts('<script src="/assets/a.js"></script>')).toEqual(['/assets/a.js'])
    expect(staticClosure(root, ['/assets/entry.js']).sort()).toEqual([
      '/assets/entry.js',
      '/assets/re.js',
      '/assets/route.js',
      '/assets/side.js',
    ])
    expect(checkHomeBundle(root).violations).toEqual([])
  })

  it('静态依赖中出现 Markdown 代码时报错', () => {
    const root = fixture({
      'index.html': '<script type="module" src="/assets/entry.js"></script>',
      'assets/entry.js': 'import"./reader.js";',
      'assets/reader.js': 'const p="user-content-";',
    })
    expect(checkHomeBundle(root).violations).toEqual([
      { asset: '/assets/reader.js', marker: 'user-content-' },
    ])
  })

  it('首页静态导入 @saas/ui/chat 时报错（对话代码块标记）', () => {
    // 模拟首页路由静态导入对话组件：chat 分包含代码块的 data-chat-code 属性
    const root = fixture({
      'index.html': '<script type="module" src="/assets/entry.js"></script>',
      'assets/entry.js': 'import{ChatMarkdown as c}from"./chat.js";',
      'assets/chat.js': 'const e=t("div",{"data-chat-code":"",className:"mb-2.5"});',
    })
    expect(checkHomeBundle(root).violations).toEqual([
      { asset: '/assets/chat.js', marker: 'data-chat-code' },
    ])
  })

  it('客户端首页静态依赖中出现分享卡片渲染器时报错', () => {
    const root = fixture({
      'index.html': '<script type="module" src="/assets/entry.js"></script>',
      'assets/entry.js': 'import"./og.js";',
      'assets/og.js': 'throw new Error("cf-workers-og: WebAssembly is not available")',
    })
    expect(checkHomeBundle(root).violations).toEqual([
      { asset: '/assets/og.js', marker: 'cf-workers-og' },
    ])
  })

  it('客户端首页静态依赖中出现 zod schema 实现时报错；只有 jitless 配置时通过', () => {
    const ok = fixture({
      'index.html': '<script type="module" src="/assets/entry.js"></script>',
      'assets/entry.js': 'const c={};function config(o){Object.assign(c,o)}config({jitless:!0});',
    })
    expect(checkHomeBundle(ok).violations).toEqual([])
    rmSync(dir, { recursive: true, force: true })
    const bad = fixture({
      'index.html': '<script type="module" src="/assets/entry.js"></script>',
      'assets/entry.js': 'import"./schema.js";',
      'assets/schema.js': 'class ZodError extends Error{};const i={code:"invalid_type"};',
    })
    expect(checkHomeBundle(bad).violations.map((v) => v.marker)).toEqual([
      'invalid_type',
      'ZodError',
    ])
  })

  it('加载器内联脚本中的入口路径也计入首页闭包', () => {
    const root = fixture({
      'index.html':
        '<script>(function(){var css=["/assets/app.css"],js=["/assets/entry.js"]})()</script>',
      'assets/entry.js': 'import"./schema.js";',
      'assets/schema.js': 'const i={code:"invalid_type"};',
    })
    expect(checkHomeBundle(root).files.sort()).toEqual(['/assets/entry.js', '/assets/schema.js'])
  })
})

describe('水合闭包中的 zod（0.5.6）', () => {
  it('入口脚本：module script 与 after-paint 加载器的 js 列表', () => {
    expect(
      entryScripts(
        '<script type="module" async="" src="/assets/index-1.js"></script><script>(function(){var css=[],js=["/assets/index-2.js"];})()</script>',
      ),
    ).toEqual(['/assets/index-1.js', '/assets/index-2.js'])
  })

  it('入口立即 import() 的路由树分包含 zod 时报出，并按 sourcemap 列出引用 zod 的源文件', () => {
    const root = fixture({
      'index.html': '<script type="module" src="/assets/index.js"></script>',
      'assets/index.js': 'const s=async()=>{let{StartClient:e}=await import(`./client.js`)};',
      'assets/client.js': 'import{a as z}from"./schemas.js";const l=()=>import("./lazy.js");',
      'assets/client.js.map': JSON.stringify({
        sources: [
          '../../../src/routes/login.tsx',
          '../../../node_modules/x.js',
          '../../../src/a.ts',
        ],
        sourcesContent: ["import { z } from 'zod'\n", "import 'zod'", 'export const a = 1'],
      }),
      'assets/schemas.js': 'class ZodError{};const c="invalid_type";',
      'assets/lazy.js': 'import"./schemas.js";',
    })
    expect(entryDynamicImports(root, ['/assets/index.js'])).toEqual(['/assets/client.js'])
    const result = checkHomeBundle(root)
    expect(result.files).toEqual(['/assets/index.js'])
    expect(result.hydration.sort()).toEqual([
      '/assets/client.js',
      '/assets/index.js',
      '/assets/schemas.js',
    ])
    expect(result.violations.map(({ marker }) => marker).sort()).toEqual([
      'ZodError',
      'invalid_type',
    ])
    expect(result.zodSources).toEqual(['src/routes/login.tsx'])
  })

  it('路由树分包不含 zod 时通过（深层懒加载分包不计入）', () => {
    const root = fixture({
      'index.html': '<script type="module" src="/assets/index.js"></script>',
      'assets/index.js': 'await import("./client.js")',
      'assets/client.js': 'const l=()=>import("./lazy.js");',
      'assets/lazy.js': 'class ZodError{}',
    })
    expect(checkHomeBundle(root).violations).toEqual([])
  })
})

describe('首页包预算（add-marketing-critical-path）', () => {
  it('未设置预算不检查；未超出返回 null；超出给出实际值与预算', () => {
    expect(budgetViolation(500_000, null)).toBeNull()
    expect(budgetViolation(500_000, undefined)).toBeNull()
    expect(budgetViolation(1000, 1000)).toBeNull()
    expect(budgetViolation(1001, 1000)).toMatch(/1001 B.*预算 1000 B/)
  })

  it('读取构建写出的 marketing.performance，缺失时为 null', () => {
    const root = fixture({})
    expect(readPerformanceOptions(root)).toBeNull()
    mkdirSync(join(root, '.build'))
    writeFileSync(
      join(root, '.build/marketing-performance.json'),
      JSON.stringify({ homeScriptGzipBudget: 1234 }),
    )
    expect(readPerformanceOptions(root)).toEqual({ homeScriptGzipBudget: 1234 })
  })

  it('命令行：未设置预算时 zod 只警告，设置预算后判失败', () => {
    const root = fixture({})
    const files: Record<string, string> = {
      'client/index.html': '<script type="module" src="/assets/entry.js"></script>',
      'client/assets/entry.js': 'const i={code:"invalid_type"};',
      'server/index.js': '',
      'server/assets/home.js': '',
      'server/.vite/manifest.json': JSON.stringify({
        'src/routes/index.tsx': { file: 'assets/home.js' },
      }),
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    const script = new URL('./check-home-bundle.mjs', import.meta.url).pathname
    const run = () =>
      spawnSync(process.execPath, [script, join(root, 'client'), join(root, 'server')], {
        encoding: 'utf8',
      })
    const warned = run()
    expect(warned.status).toBe(0)
    expect(warned.stderr).toMatch(/zod schema/)
    mkdirSync(join(root, '.build'))
    writeFileSync(
      join(root, '.build/marketing-performance.json'),
      JSON.stringify({ homeScriptGzipBudget: 1_000_000 }),
    )
    const failed = run()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/invalid_type/)
  })

  it('命令行超出预算时失败', () => {
    // 目录结构同构建产物：<root>/client（客户端）、<root>/server（服务端）、<root>/.build（构建配置）
    const root = fixture({})
    const files: Record<string, string> = {
      'client/index.html': '<script type="module" src="/assets/entry.js"></script>',
      // 不易压缩的内容，确保 gzip 后超过 100 B
      'client/assets/entry.js': `const big="${Array.from({ length: 400 }, (_, i) => (i * 7919).toString(36)).join(',')}";`,
      'server/index.js': '',
      'server/assets/home.js': '',
      'server/.vite/manifest.json': JSON.stringify({
        'src/routes/index.tsx': { file: 'assets/home.js' },
      }),
      '.build/marketing-performance.json': JSON.stringify({ homeScriptGzipBudget: 100 }),
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    const script = new URL('./check-home-bundle.mjs', import.meta.url).pathname
    const result = spawnSync(
      process.execPath,
      [script, join(root, 'client'), join(root, 'server')],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/超出预算 100 B/)
  })
})

describe('服务端首页闭包（add-og-images 5.5）', () => {
  const manifest = JSON.stringify({
    'virtual:cloudflare/worker-entry': { file: 'index.js', isEntry: true },
    'src/routes/index.tsx?tsr-split=component': { file: 'assets/home.js' },
    'src/server/cloudflare/share-card-renderer.ts': { file: 'assets/renderer.js' },
  })
  const renderer =
    'import{initWasm as i}from"@resvg/resvg-wasm";import y from"./yoga.wasm";import f from"./inter-latin-400-normal.woff-x.bin";'

  it('渲染器只经动态 import() 加载时通过', () => {
    const root = fixture({
      '.vite/manifest.json': manifest,
      'index.js': 'import{a}from"./assets/router.js";const r=()=>import("./assets/renderer.js");',
      'assets/router.js': '',
      'assets/home.js': 'import"./ui.js";',
      'assets/ui.js': '',
      'assets/renderer.js': renderer,
    })
    const result = checkServerHomeBundle(root)
    expect(result.routeEntries).toEqual(['/assets/home.js'])
    expect(result.files.sort()).toEqual([
      '/assets/home.js',
      '/assets/router.js',
      '/assets/ui.js',
      '/index.js',
    ])
    expect(result.violations).toEqual([])
  })

  it('首页路由静态导入渲染器时检查失败', () => {
    const root = fixture({
      '.vite/manifest.json': manifest,
      'index.js': 'const r=()=>import("./assets/home.js");',
      'assets/home.js': 'import{render}from"./renderer.js";',
      'assets/renderer.js': renderer,
    })
    const markers = checkServerHomeBundle(root).violations.map((v) => v.marker)
    expect(markers).toEqual(
      expect.arrayContaining([
        'resvg',
        'initWasm',
        './yoga.wasm',
        './inter-latin-400-normal.woff-x.bin',
      ]),
    )
  })

  it('Worker 入口静态导入渲染器时检查失败', () => {
    const root = fixture({
      '.vite/manifest.json': manifest,
      'index.js': 'import"./assets/renderer.js";',
      'assets/home.js': '',
      'assets/renderer.js': renderer,
    })
    expect(checkServerHomeBundle(root).violations.length).toBeGreaterThan(0)
  })

  it('命令行缺少服务端产物时失败，不静默通过', () => {
    const root = fixture({
      'index.html': '<script type="module" src="/assets/entry.js"></script>',
      'assets/entry.js': '',
    })
    const script = new URL('./check-home-bundle.mjs', import.meta.url).pathname
    const result = spawnSync(process.execPath, [script, root, join(root, 'missing-server')], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('找不到服务端产物')
  })
})
