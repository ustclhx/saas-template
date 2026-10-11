import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TOKENS_PER_CHAR,
  parseMediaSchema,
  textModelConfigSchema,
} from '@saas/ai/client'
import { AppError } from '@saas/shared'

/** 后台与保存接口共用校验；保留管理员输入的标题、描述等原始 schema 内容。 */
export function parseAdminParamsSchema(
  kind: 'text' | 'image' | 'video',
  json: string,
): Record<string, unknown> {
  let schema: unknown
  try {
    schema = JSON.parse(json)
  } catch {
    throw new AppError('PARAMS_SCHEMA_INVALID', '参数 schema 必须是合法 JSON')
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new AppError('PARAMS_SCHEMA_INVALID', '参数 schema 必须是 JSON 对象')
  }
  const paramsSchema = schema as Record<string, unknown>
  if (kind === 'text') {
    if (Object.hasOwn(paramsSchema, 'x-text')) {
      const parsed = textModelConfigSchema.safeParse(paramsSchema['x-text'])
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const field = ['x-text', ...(issue?.path ?? [])].join('.')
        throw new AppError(
          'PARAMS_SCHEMA_INVALID',
          `${field} 配置无效：tokensPerChar 必须为正数，maxOutputTokens 必须为正整数`,
        )
      }
    }
  } else {
    try {
      parseMediaSchema(paramsSchema)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      throw new AppError(
        'PARAMS_SCHEMA_INVALID',
        '媒体参数 schema 无效：请使用参考模板中的平面字段格式与支持的校验规则',
        { cause: error },
      )
    }
  }
  return paramsSchema
}

interface ParamsSchemaTemplate {
  id: string
  label: string
  kind: 'text' | 'image' | 'video'
  provider: string
  providerModelId: string
  schema: Record<string, unknown>
}

export const PARAMS_SCHEMA_TEMPLATES: ParamsSchemaTemplate[] = [
  {
    id: 'text-defaults',
    label: '文本 · x-text 默认值',
    kind: 'text',
    provider: '*',
    providerModelId: '*',
    schema: {
      'x-text': {
        tokensPerChar: DEFAULT_TOKENS_PER_CHAR,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      },
    },
  },
  {
    id: 'workers-ai-flux-schnell',
    label: 'Workers AI · FLUX schnell',
    kind: 'image',
    provider: 'workers-ai',
    providerModelId: '@cf/black-forest-labs/flux-1-schnell',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: '提示词', minLength: 1, maxLength: 2048 },
        steps: { type: 'integer', title: '推理步数', minimum: 1, maximum: 8, default: 4 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    id: 'fal-flux-schnell',
    label: 'fal · FLUX schnell',
    kind: 'image',
    provider: 'fal',
    providerModelId: 'fal-ai/flux/schnell',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: '提示词', minLength: 1 },
        image_size: {
          type: 'string',
          title: '图片尺寸',
          enum: [
            'square_hd',
            'square',
            'portrait_4_3',
            'portrait_16_9',
            'landscape_4_3',
            'landscape_16_9',
          ],
          default: 'landscape_4_3',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
]
