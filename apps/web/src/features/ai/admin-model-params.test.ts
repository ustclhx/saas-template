import { createMediaParamsValidator, parseMediaSchema } from '@saas/ai/client'
import { AppError } from '@saas/shared'
import { describe, expect, it } from 'vitest'
import { PARAMS_SCHEMA_TEMPLATES, parseAdminParamsSchema } from './admin-model-params.ts'

describe('parseAdminParamsSchema', () => {
  it.each(['{', '', 'null', '[]', '1', '"schema"'])('rejects invalid JSON objects: %s', (json) => {
    expect(() => parseAdminParamsSchema('text', json)).toThrow(AppError)
  })

  it.each([
    {},
    { type: 'object', properties: { nested: { type: 'object' } } },
    { type: 'object', properties: { prompt: { type: 'string', pattern: '[' } } },
    { type: 'object', properties: {}, required: ['prompt'] },
  ])('rejects unsupported media schemas: %j', (schema) => {
    expect(() => parseAdminParamsSchema('image', JSON.stringify(schema))).toThrow(
      '媒体参数 schema 无效',
    )
  })

  it.each([
    { tokensPerChar: 0 },
    { tokensPerChar: -1 },
    { tokensPerChar: '1' },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    null,
  ])('rejects invalid text configuration: %j', (config) => {
    expect(() => parseAdminParamsSchema('text', JSON.stringify({ 'x-text': config }))).toThrow(
      'x-text',
    )
  })

  it('allows text defaults and preserves schema metadata', () => {
    expect(parseAdminParamsSchema('text', '{}')).toEqual({})
    const schema = { title: '文本模型', 'x-text': { tokensPerChar: 1.5, maxOutputTokens: 2048 } }
    expect(parseAdminParamsSchema('text', JSON.stringify(schema))).toEqual(schema)
  })

  it('preserves media schema content without inserting omitted fields', () => {
    const schema = { type: 'object', title: '测试', properties: { prompt: { type: 'string' } } }
    expect(parseAdminParamsSchema('image', JSON.stringify(schema))).toEqual(schema)
  })
})

describe('parameter schema templates', () => {
  it.each(PARAMS_SCHEMA_TEMPLATES)('$id is accepted by the shared parser', ({ kind, schema }) => {
    expect(parseAdminParamsSchema(kind, JSON.stringify(schema))).toEqual(schema)
    if (kind !== 'text') {
      const validator = createMediaParamsValidator(parseMediaSchema(schema), kind)
      expect(validator.safeParse({ prompt: 'A red square' }).success).toBe(true)
    }
  })
})
