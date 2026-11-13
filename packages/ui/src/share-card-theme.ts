import { type TypeScaleRole, type TypeScaleStep, typeScale } from './lib/type-scale.ts'

/** 服务端版式使用已解析的值；圆角与字号的单位均为 px。 */
export interface ShareCardTheme {
  readonly background: string
  readonly foreground: string
  readonly muted: string
  readonly primary: string
  readonly primaryText: string
  readonly border: string
  readonly radius: number
  readonly fontSize: Readonly<Record<TypeScaleRole, Readonly<TypeScaleStep>>>
}

// 服务端无法读取 CSS 变量；与 styles/globals.css 的基线同步，品牌覆盖由项目维护。
export const shareCardThemes: Readonly<Record<'light' | 'dark', ShareCardTheme>> = {
  light: {
    background: '#fafafa',
    foreground: '#171717',
    muted: '#f4f4f5',
    primary: '#171717',
    primaryText: '#171717',
    border: 'rgba(23, 23, 23, 0.12)',
    radius: 8,
    fontSize: typeScale,
  },
  dark: {
    background: '#171717',
    foreground: '#f5f5f5',
    muted: '#1e1e1e',
    primary: '#f5f5f5',
    primaryText: '#f5f5f5',
    border: 'rgba(245, 245, 245, 0.12)',
    radius: 8,
    fontSize: typeScale,
  },
}
