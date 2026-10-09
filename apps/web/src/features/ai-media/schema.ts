import { estimateCredits, type Pricing } from '@saas/ai/client'
import { z } from 'zod'
import type { MediaFile } from './client.ts'

const scalar = z.union([z.string(), z.number().finite(), z.boolean()])
const property = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(scalar).min(1).optional(),
  default: scalar.optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  exclusiveMinimum: z.number().finite().optional(),
  exclusiveMaximum: z.number().finite().optional(),
  multipleOf: z.number().positive().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.enum(['file', 'uuid']).optional(),
})

const schema = z.strictObject({
  $schema: z.string().optional(),
  type: z.literal('object'),
  title: z.string().optional(),
  description: z.string().optional(),
  properties: z.record(z.string(), property),
  required: z.array(z.string()).default([]),
  additionalProperties: z.literal(false).optional(),
  'x-media': z.strictObject({ unitsParam: z.string().min(1).optional() }).optional(),
})

export type MediaSchema = z.infer<typeof schema>
export type MediaProperty = z.infer<typeof property>
export type MediaParams = Record<string, string | number | boolean>
export interface MediaModel {
  key: string
  kind: 'text' | 'image' | 'video'
  pricing: Pricing
  paramsSchema: string | null
}

/** 明确支持平面 JSON Schema 子集；未知约束不能静默忽略后允许提交。 */
export function parseMediaSchema(input: Record<string, unknown> | null): MediaSchema {
  const result = schema.parse(input)
  if (result.required.some((name) => !Object.hasOwn(result.properties, name)))
    throw new Error('MEDIA_SCHEMA_UNSUPPORTED')
  for (const field of Object.values(result.properties)) {
    if (
      (field.format !== undefined && field.type !== 'string') ||
      (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
    )
      throw new Error('MEDIA_SCHEMA_UNSUPPORTED')
    // 提前构建校验器，正则等配置错误应显示模型不可用，而不是在用户提交时抛错。
    valueSchema(field)
  }
  return result
}

function valueSchema(field: MediaProperty): z.ZodType {
  let value: z.ZodType
  if (field.type === 'number' || field.type === 'integer') {
    let numeric = z.number().finite()
    if (field.type === 'integer') numeric = numeric.int()
    if (field.minimum !== undefined) numeric = numeric.min(field.minimum)
    if (field.maximum !== undefined) numeric = numeric.max(field.maximum)
    if (field.exclusiveMinimum !== undefined) numeric = numeric.gt(field.exclusiveMinimum)
    if (field.exclusiveMaximum !== undefined) numeric = numeric.lt(field.exclusiveMaximum)
    if (field.multipleOf !== undefined) numeric = numeric.multipleOf(field.multipleOf)
    value = numeric
  } else if (field.type === 'boolean') {
    value = z.boolean()
  } else {
    let text = z.string()
    if (field.minLength !== undefined) text = text.min(field.minLength)
    if (field.maxLength !== undefined) text = text.max(field.maxLength)
    if (field.pattern !== undefined) text = text.regex(new RegExp(field.pattern))
    value = field.format === 'file' || field.format === 'uuid' ? text.uuid() : text
  }
  if (field.enum)
    value = value.refine((input) => field.enum?.includes(input as z.infer<typeof scalar>))
  return value
}

export function initialMediaParams(schema: MediaSchema): MediaParams {
  const params: MediaParams = {}
  for (const [name, field] of Object.entries(schema.properties)) {
    // 文件默认值不能绕过 ready 选择；其余默认值必须满足字段约束。
    if (field.format !== 'file' && field.default !== undefined) {
      if (!valueSchema(field).safeParse(field.default).success)
        throw new Error('MEDIA_SCHEMA_UNSUPPORTED')
      params[name] = field.default
    } else if (field.type === 'boolean' && schema.required.includes(name)) {
      params[name] = false
    }
  }
  return params
}

export function validateMediaParams(
  schema: MediaSchema,
  params: MediaParams,
  files: readonly MediaFile[],
) {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, field] of Object.entries(schema.properties)) {
    let value = valueSchema(field)
    if (field.format === 'file')
      value = value.refine((id) => files.some((file) => file.id === id && file.status === 'ready'))
    shape[name] = schema.required.includes(name) ? value : value.optional()
  }
  return z.strictObject(shape).safeParse(params)
}

/** 只映射用量参数；所有倍率、取整与金额校验都复用 packages/ai 的定价函数。 */
export function mediaCreditEstimate(model: MediaModel, schema: MediaSchema, params: MediaParams) {
  const pricing = model.pricing
  if (pricing.mode === 'token') throw new Error('MEDIA_PRICING_UNSUPPORTED')
  const explicit = schema['x-media']?.unitsParam
  const name = explicit ?? (model.kind === 'image' ? 'num_images' : 'duration')
  const units = params[name] ?? 1
  if (
    typeof units !== 'number' ||
    units <= 0 ||
    (model.kind === 'image' && !Number.isSafeInteger(units))
  )
    throw new Error('MEDIA_ESTIMATE_UNAVAILABLE')
  if (pricing.mode === 'per_call') return estimateCredits(pricing, { params })
  return estimateCredits(pricing, { params, units })
}
