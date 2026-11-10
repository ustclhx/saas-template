// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { UI_PRESETS } from '../src/index.ts'

// 主题预设的正文对比度（WCAG AA ≥ 4.5:1）：从 globals.css 与 presets/*.css 读取变量，
// 按「基线 → 预设」与「浅色 → .dark」的层叠顺序解析，再计算相对亮度对比度。
const styles = new URL('../src/styles/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, styles), 'utf8')

/** 取出指定选择器（完全匹配）规则块中的自定义属性 */
function block(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // 选择器文本可能带着前面的 @import / @custom-variant 语句，只取最后一个分号之后的部分
    const selectors = (match[1] ?? '')
      .split(';')
      .at(-1)
      ?.split(',')
      .map((s) => s.trim())
    if (!selectors) continue
    if (!selectors.includes(selector)) continue
    for (const decl of (match[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars[decl[1] as string] = (decl[2] as string).trim()
    }
  }
  return vars
}

function resolve(vars: Record<string, string>, name: string, depth = 0): string {
  const value = vars[name]
  if (value === undefined) throw new Error(`未定义的变量 ${name}`)
  const ref = /^var\((--[\w-]+)\)$/.exec(value)
  if (ref && depth < 10) return resolve(vars, ref[1] as string, depth + 1)
  return value
}

/** #rrggbb 或 oklch(L C H) → 线性 sRGB 的相对亮度 */
function luminance(color: string): number {
  let rgb: [number, number, number]
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(color)
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16)
    const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
    rgb = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
      number,
      number,
      number,
    ]
  } else if (oklch) {
    const [l, c, h] = [Number(oklch[1]), Number(oklch[2]), (Number(oklch[3]) * Math.PI) / 180]
    const a = c * Math.cos(h)
    const b = c * Math.sin(h)
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
    rgb = [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
  } else {
    throw new Error(`无法解析的颜色 ${color}`)
  }
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// 正文与按钮文字的前景 / 背景组合
const PAIRS = [
  ['--foreground', '--background'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--muted-foreground', '--background'],
  ['--primary-foreground', '--primary'],
  ['--secondary-foreground', '--secondary'],
  ['--destructive', '--background'],
] as const

describe('主题预设', () => {
  const globals = read('globals.css')

  it('四个预设都有样式文件并由 globals.css 导入', () => {
    expect([...UI_PRESETS]).toEqual(['neutral', 'blue', 'violet', 'green'])
    for (const preset of UI_PRESETS) {
      expect(globals).toContain(`@import "./presets/${preset}.css";`)
      expect(read(`presets/${preset}.css`)).toContain(`:root[data-preset="${preset}"]`)
    }
  })

  for (const preset of UI_PRESETS) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${preset} ${mode} 正文对比度不低于 4.5:1`, () => {
        const css = read(`presets/${preset}.css`)
        const vars = {
          ...block(globals, ':root'),
          ...block(css, `:root[data-preset="${preset}"]`),
          ...(mode === 'dark'
            ? { ...block(globals, '.dark'), ...block(css, `:root[data-preset="${preset}"].dark`) }
            : {}),
        }
        // 预设的浅色值在暗色下仍会生效（选择器优先级更高），暗色必须逐项覆盖
        if (mode === 'dark') {
          const light = Object.keys(block(css, `:root[data-preset="${preset}"]`))
          const dark = block(css, `:root[data-preset="${preset}"].dark`)
          for (const name of light.filter((n) => n !== '--radius'))
            expect(dark).toHaveProperty(name)
        }
        for (const [fg, bg] of PAIRS) {
          const ratio = contrast(resolve(vars, fg), resolve(vars, bg))
          expect(ratio, `${fg} / ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }
})
