import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findRuntimeRequires } from './check-node-requires.mjs'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('findRuntimeRequires', () => {
  it('只放行内置模块，并跳过 trace 出的 node_modules', () => {
    dir = mkdtempSync(join(tmpdir(), 'node-requires-'))
    mkdirSync(join(dir, '_ssr'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(
      join(dir, '_ssr', 'ssr.mjs'),
      'var a = __require("node:fs"); var b = __require("fs/promises"); var react = __require("react");',
    )
    writeFileSync(join(dir, 'node_modules', 'x.mjs'), 'var d = __require("react-dom");')
    expect(findRuntimeRequires(dir)).toEqual([
      { file: join('_ssr', 'ssr.mjs'), specifier: 'react' },
    ])
  })
})
