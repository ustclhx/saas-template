import { shareCardThemes } from '@saas/ui/share-card-theme'
import { projectShareCardTheme } from './share-cards.theme.ts'
import type { ShareCardTheme } from './types.ts'

export type ShareCardThemeMode = 'light' | 'dark'

/** 模板基线叠加项目品牌覆盖；项目覆盖对浅色与深色同时生效。 */
export function resolveShareCardTheme(mode: ShareCardThemeMode = 'light'): ShareCardTheme {
  return { ...shareCardThemes[mode], ...projectShareCardTheme }
}
