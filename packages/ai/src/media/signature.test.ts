import { expect, it } from 'vitest'
import {
  mediaCallbackUrl,
  parseMediaCallbackAttempt,
  verifyMediaCallbackSignature,
} from './signature.ts'

it('binds media callback signatures to the task and secret', async () => {
  const task = { id: '019bb460-a610-7000-8000-000000000001', provider: 'fal' }
  const url = new URL(await mediaCallbackUrl('https://example.test', 'fixture-secret', task))
  const signature = url.searchParams.get('sig') ?? ''
  expect(url.pathname).toBe('/api/webhooks/media/fal')
  expect(url.searchParams.get('task')).toBe(task.id)
  expect(await verifyMediaCallbackSignature('fixture-secret', task.id, signature)).toBe(true)
  expect(await verifyMediaCallbackSignature('fixture-secret', 'other-task', signature)).toBe(false)
  expect(await verifyMediaCallbackSignature('wrong-secret', task.id, signature)).toBe(false)
  expect(await verifyMediaCallbackSignature('fixture-secret', task.id, 'bad')).toBe(false)
})

it('signs the attempt number and keeps attempt 0 in the legacy format', async () => {
  const task = { id: '019bb460-a610-7000-8000-000000000002', provider: 'replicate' }
  const legacy = new URL(await mediaCallbackUrl('https://example.test', 's', task))
  const zero = new URL(await mediaCallbackUrl('https://example.test', 's', { ...task, attempt: 0 }))
  expect(zero.toString()).toBe(legacy.toString())
  expect(zero.searchParams.has('attempt')).toBe(false)
  const first = new URL(
    await mediaCallbackUrl('https://example.test', 's', { ...task, attempt: 1 }),
  )
  const signature = first.searchParams.get('sig') ?? ''
  expect(first.searchParams.get('attempt')).toBe('1')
  expect(await verifyMediaCallbackSignature('s', task.id, signature, 1)).toBe(true)
  // 序号被改写或去掉时签名不再成立
  expect(await verifyMediaCallbackSignature('s', task.id, signature, 0)).toBe(false)
  expect(await verifyMediaCallbackSignature('s', task.id, signature, 2)).toBe(false)
  expect(parseMediaCallbackAttempt(null)).toBe(0)
  expect(parseMediaCallbackAttempt('2')).toBe(2)
  for (const bad of ['0', '01', '-1', '1.5', '100', 'a'])
    expect(parseMediaCallbackAttempt(bad)).toBeNull()
})
