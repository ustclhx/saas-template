import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkHomeBundle, htmlScripts, staticClosure } from './check-home-bundle.mjs'

let dir = ''

function fixture(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'home-bundle-'))
  mkdirSync(join(dir, 'assets'))
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
})
