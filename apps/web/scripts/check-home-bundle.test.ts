import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkHomeBundle,
  checkServerHomeBundle,
  htmlScripts,
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
