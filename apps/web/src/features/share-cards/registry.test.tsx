import { describe, expect, it } from 'vitest'
import { isShareCardExpired, shareCardExpiresAt } from './expiry.ts'
import { defaultShareTokenPattern, getShareCard, registerShareCard } from './registry.ts'
import { registerSampleShareCard, sampleShareToken } from './sample.ts'
import { createShareToken } from './token.ts'
import type { ShareCardDefinition } from './types.ts'

const definition: ShareCardDefinition<{ title: string }> = {
  type: 'registry-test',
  version: 1,
  resolve: async () => null,
  digest: (data) => data.title,
  render: () => <div />,
  alt: (data) => data.title,
  page: (data) => ({ title: data.title, description: '' }),
}

describe('share card registry', () => {
  it('rejects duplicate types and leaves unknown types unregistered', () => {
    expect(getShareCard('unregistered')).toBeUndefined()
    const registered = registerShareCard(definition)
    expect(getShareCard(definition.type)).toBe(registered)
    expect(registered.tokenPattern).toEqual(defaultShareTokenPattern)
    expect(registered.ttlDays).toBe(90)
    expect(registered.sharePage).toBe(true)
    expect(() => registerShareCard(definition)).toThrow(/already registered/)
    expect(() => registerShareCard({ ...definition, type: '../invalid' })).toThrow(TypeError)
  })

  it('keeps per-type token, expiry and share-page choices', () => {
    const custom = registerShareCard({
      ...definition,
      type: 'custom-test',
      ttlDays: 30,
      tokenPattern: /^custom-[a-z]+$/,
      sharePage: false,
    })
    expect(custom.ttlDays).toBe(30)
    expect(custom.tokenPattern.test('custom-example')).toBe(true)
    expect(custom.sharePage).toBe(false)
    expect(
      registerShareCard({ ...definition, type: 'permanent-test', ttlDays: null }).ttlDays,
    ).toBeNull()
  })

  it('registers the memory-only sample explicitly', async () => {
    expect(getShareCard('sample')).toBeUndefined()
    const sample = registerSampleShareCard(() => <div />)
    const ctx = { db: {} as Parameters<typeof sample.resolve>[1]['db'] }
    expect((await sample.resolve(sampleShareToken, ctx))?.data.title).toBe('Project summary')
    expect(await sample.resolve('missing', ctx)).toBeNull()
  })
})

it('creates independent 32-byte base64url tokens within the default format', () => {
  const tokens = Array.from({ length: 20 }, createShareToken)
  expect(new Set(tokens).size).toBe(tokens.length)
  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(defaultShareTokenPattern.test(token)).toBe(true)
    expect(atob(`${token.replaceAll('-', '+').replaceAll('_', '/')}=`).length).toBe(32)
  }
  for (const invalid of [
    'a'.repeat(21),
    'a'.repeat(65),
    `${'a'.repeat(22)}/`,
    `${'a'.repeat(22)}=`,
  ]) {
    expect(defaultShareTokenPattern.test(invalid)).toBe(false)
  }
})

describe('share card expiry', () => {
  const sharedAt = new Date('2026-01-01T12:00:00Z')
  it('uses 90 days by default and allows a type to select 30 days', () => {
    expect(shareCardExpiresAt({ sharedAt })).toEqual(new Date('2026-04-01T12:00:00Z'))
    const expiry = shareCardExpiresAt({ sharedAt }, 30)
    expect(expiry).toEqual(new Date('2026-01-31T12:00:00Z'))
    expect(isShareCardExpired(expiry, new Date('2026-01-31T11:59:59Z'))).toBe(false)
    expect(isShareCardExpired(expiry, new Date('2026-01-31T12:00:00Z'))).toBe(true)
  })

  it('gives explicit expiresAt priority, including null, over type defaults', () => {
    const expiresAt = new Date('2026-01-05T12:00:00Z')
    expect(shareCardExpiresAt({ sharedAt, expiresAt }, null)).toBe(expiresAt)
    expect(shareCardExpiresAt({ sharedAt, expiresAt: null }, 30)).toBeNull()
    expect(shareCardExpiresAt({ sharedAt }, null)).toBeNull()
    expect(isShareCardExpired(null, new Date('2099-01-01T00:00:00Z'))).toBe(false)
  })
})
