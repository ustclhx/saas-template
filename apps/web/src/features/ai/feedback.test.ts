import { describe, expect, it } from 'vitest'
import { feedbackInputSchema, normalizeFeedbackComment, scrubSecrets } from './feedback.ts'
import { parseQuestions } from './follow-ups.server.ts'

// add-subject-chat tasks.md 3.1、3.2：反馈文字去密钥、输入只接受引用、后续问题解析。

describe('feedback comments', () => {
  it('redacts secrets and tokens', () => {
    const text = [
      'key sk-proj-AbCdEf0123456789ghijKLMN',
      'auth Bearer abc.def.ghi-123456',
      'aws AKIAABCDEFGHIJKLMNOP',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'hex 0123456789abcdef0123456789abcdef',
    ].join('\n')
    const scrubbed = scrubSecrets(text)
    for (const secret of [
      'sk-proj',
      'Bearer abc',
      'AKIA',
      'ghp_',
      'eyJhbGci',
      '0123456789abcdef0123',
    ])
      expect(scrubbed).not.toContain(secret)
    expect(scrubSecrets('The answer was too long and missed my question.')).toBe(
      'The answer was too long and missed my question.',
    )
    expect(normalizeFeedbackComment('   ')).toBeNull()
    expect(normalizeFeedbackComment(' ok ')).toBe('ok')
  })

  it('only accepts a message reference, rating and comment', () => {
    const base = { slug: 's', messageId: '0190f5d8-7a3b-7c3d-8e4f-1234567890ab', rating: 'up' }
    expect(feedbackInputSchema.safeParse(base).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, rating: null }).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, modelKey: 'x' }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ ...base, comment: 'x'.repeat(1001) }).success).toBe(
      false,
    )
  })
})

describe('follow-up parsing', () => {
  it('reads a JSON array, falls back to lines, dedupes and caps the count', () => {
    expect(parseQuestions('Sure: ["A?", "B?", "A?", "C?", "D?"]', 3)).toEqual(['A?', 'B?', 'C?'])
    expect(parseQuestions('1. First?\n2) Second?\n- Third?', 2)).toEqual(['First?', 'Second?'])
    expect(parseQuestions('', 3)).toEqual([])
  })
})
