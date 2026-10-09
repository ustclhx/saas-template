import type { AiTask } from '@saas/db'
import { AppError } from '@saas/shared'
import { z } from 'zod'

export interface MediaTaskInput {
  params: Record<string, unknown>
  providerModelId: string
  unitsLimit: number
  fileParams: string[]
  storageBytes: number
  callbackOrigin?: string | undefined
}

const snapshot = z.object({
  params: z.record(z.string(), z.unknown()),
  providerModelId: z.string().min(1),
  unitsLimit: z.number().finite().positive(),
  fileParams: z.array(z.string().min(1)),
  storageBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  callbackOrigin: z.url({ protocol: /^https?$/ }).optional(),
})

export function readMediaTaskInput(task: Pick<AiTask, 'input'>): MediaTaskInput {
  const parsed = snapshot.safeParse(task.input)
  if (!parsed.success)
    throw new AppError('MEDIA_INPUT_INVALID', 'Invalid media task snapshot', { status: 500 })
  return parsed.data
}

const configurationError = () =>
  new AppError('MEDIA_SCHEMA_INVALID', 'Media model parameter schema is not supported', {
    status: 503,
  })
const rootKeys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  '$schema',
  'x-media',
])
const fieldKeys = new Set([
  'type',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'default',
  'title',
  'description',
])
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const fieldSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  enum: z
    .array(z.union([z.string(), z.number().finite(), z.boolean()]))
    .min(1)
    .optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  exclusiveMinimum: z.number().finite().optional(),
  exclusiveMaximum: z.number().finite().optional(),
  multipleOf: z.number().finite().positive().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.enum(['file', 'uuid']).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
})

/** 首版表单只支持平面标量字段；未知校验关键字必须拒绝，不能静默忽略而放行。 */
export function validateMediaParams(
  schema: Record<string, unknown> | null,
  params: Record<string, unknown>,
  kind: 'image' | 'video',
): { params: Record<string, unknown>; fileParams: string[]; unitsLimit: number } {
  if (
    schema?.type !== 'object' ||
    !plainObject(schema.properties) ||
    Object.keys(schema).some((key) => !rootKeys.has(key)) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key) =>
            typeof key !== 'string' ||
            !Object.hasOwn(schema.properties as Record<string, unknown>, key),
        )))
  )
    throw configurationError()
  const properties: Record<string, Record<string, unknown>> = {}
  const fileParams: string[] = []
  for (const [name, field] of Object.entries(schema.properties)) {
    if (
      !plainObject(field) ||
      !fieldSchema.safeParse(field).success ||
      !['string', 'number', 'integer', 'boolean'].includes(String(field.type)) ||
      Object.keys(field).some((key) => !fieldKeys.has(key)) ||
      (field.format !== undefined && field.format !== 'file' && field.format !== 'uuid')
    )
      throw configurationError()
    if (field.format === 'file') {
      if (field.type !== 'string') throw configurationError()
      fileParams.push(name)
    }
    properties[name] = { ...field, ...(field.format === 'file' ? { format: 'uuid' } : {}) }
  }
  const media = schema['x-media']
  if (
    media !== undefined &&
    (!plainObject(media) ||
      Object.keys(media).some((key) => key !== 'unitsParam') ||
      (media.unitsParam !== undefined && typeof media.unitsParam !== 'string'))
  )
    throw configurationError()
  const unitsParam =
    (plainObject(media) ? media.unitsParam : undefined) ??
    (kind === 'image' ? 'num_images' : 'duration')
  if (
    plainObject(media) &&
    media.unitsParam !== undefined &&
    !['number', 'integer'].includes(String(properties[String(unitsParam)]?.type))
  )
    throw configurationError()
  let validator: z.ZodType
  try {
    validator = z.fromJSONSchema({
      ...schema,
      properties,
      additionalProperties: false,
      'x-media': undefined,
    } as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    throw configurationError()
  }
  const parsed = validator.safeParse(params)
  if (!parsed.success) throw new AppError('INVALID_PARAMS', 'Invalid media model parameters')
  const validated = parsed.data as Record<string, unknown>
  const unitsLimit = validated[String(unitsParam)] ?? 1
  if (
    typeof unitsLimit !== 'number' ||
    !Number.isFinite(unitsLimit) ||
    unitsLimit <= 0 ||
    (kind === 'image' && !Number.isSafeInteger(unitsLimit))
  )
    throw new AppError('INVALID_PARAMS', 'Media units must be positive')
  return {
    params: validated,
    fileParams: fileParams.filter((name) => validated[name] !== undefined),
    unitsLimit,
  }
}
