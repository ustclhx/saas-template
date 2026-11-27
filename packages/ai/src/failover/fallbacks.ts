/** 备用链（add-media-provider-fallback 决策 D2）：存于 ai_model.fallbacks，按顺序尝试。 */
export interface ModelFallback {
  /** 被引用模型的 ai_model.key；与主模型同类型、服务商互不相同。 */
  readonly modelKey: string
  /** 媒体模型参数改名：主模型字段 → 备用模型字段；未列出的字段同名透传。 */
  readonly paramMap?: Readonly<Record<string, string>>
}

export const MAX_MODEL_FALLBACKS = 2
