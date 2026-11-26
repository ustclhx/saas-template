import type { TemplateConfig } from '@saas/config'

export const STUDIO_KINDS = ['image', 'video'] as const
export type StudioKind = (typeof STUDIO_KINDS)[number]

type StudioTemplateConfig = {
  readonly plugins: TemplateConfig<string>['plugins']
  readonly ai: Pick<TemplateConfig<string>['ai'], StudioKind>
}

export function enabledStudioKinds(config: StudioTemplateConfig): StudioKind[] {
  const studio = config.plugins.studio
  if (!studio) return []

  // 生成插件注册表时已校验配置，客户端只读取模式，不加载 Zod。
  const { kinds = STUDIO_KINDS } = studio as { readonly kinds?: readonly StudioKind[] }
  return STUDIO_KINDS.filter((kind) => config.ai[kind] && kinds.includes(kind))
}
