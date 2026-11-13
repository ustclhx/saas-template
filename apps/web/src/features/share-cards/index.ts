import { registerProjectShareCards } from './share-cards.project.ts'

// 公开分享入口加载时才初始化项目注册，避免首页提前加载分享模块。
registerProjectShareCards()

export { isShareCardExpired, shareCardExpiresAt } from './expiry.ts'
export { defaultShareTokenPattern, getShareCard, registerShareCard } from './registry.ts'
export { createShareToken } from './token.ts'
export type {
  RegisteredShareCard,
  ShareCardContext,
  ShareCardDefinition,
  ShareCardTheme,
  ShareResolution,
} from './types.ts'
