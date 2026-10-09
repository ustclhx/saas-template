import { AppError } from '@saas/shared'
import { describe, expect, it } from 'vitest'
import { readMediaTaskInput, validateMediaParams } from './input.ts'

const fileId = '019bb460-a610-7000-8000-000000000001'
const schema = {
  type: 'object',
  required: ['prompt', 'resolution', 'source'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    resolution: { type: 'string', enum: ['720p', '1080p'] },
    seconds: { type: 'number', minimum: 1, maximum: 10 },
    steps: { type: 'integer', minimum: 1, maximum: 50 },
    enhance: { type: 'boolean', default: false },
    source: { type: 'string', format: 'file' },
  },
  'x-media': { unitsParam: 'seconds' },
}
const params = { prompt: 'hello', resolution: '720p', source: fileId, seconds: 5, steps: 3 }

describe('media request snapshot', () => {
  it('uses the model schema for enum, range, integer and file reference validation', () => {
    expect(validateMediaParams(schema, params, 'video')).toEqual({
      params: { ...params, enhance: false },
      fileParams: ['source'],
      unitsLimit: 5,
    })
    for (const invalid of [
      { resolution: '4k' },
      { seconds: 11 },
      { steps: 2.5 },
      { source: 'https://untrusted.example/input.png' },
      { extra: true },
    ])
      expect(() => validateMediaParams(schema, { ...params, ...invalid }, 'video')).toThrow(
        'Invalid media model parameters',
      )
  })

  it('rejects unsupported schema configuration and corrupted persisted snapshots', () => {
    expect(() => validateMediaParams({ ...schema, if: {} }, params, 'video')).toThrow(AppError)
    expect(() =>
      readMediaTaskInput({
        input: {
          params: {},
          providerModelId: 'fal-ai/model',
          unitsLimit: 1,
          fileParams: [],
          storageBytes: -1,
        },
      }),
    ).toThrow('Invalid media task snapshot')
  })

  it('freezes positive requested units including defaults, and rejects zero-cost unit requests', () => {
    const image = {
      type: 'object',
      properties: { num_images: { type: 'integer', default: 2, minimum: 1 } },
    }
    expect(validateMediaParams(image, {}, 'image').unitsLimit).toBe(2)
    expect(() => validateMediaParams(image, { num_images: 0 }, 'image')).toThrow(AppError)
  })
})
