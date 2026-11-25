import { describe, expect, it } from 'vitest'
import { auditRows } from './audit.ts'

const log = {
  id: '00000000-0000-7000-8000-000000000001',
  action: 'setting.updated',
  targetType: 'setting',
  targetId: 'operations.telegramBotToken',
  meta: { key: 'operations.telegramBotToken', oldValue: '1:secret', newValue: '2:secret' },
}

describe('auditRows', () => {
  it('保留项目附加在行上的字段（如多站点的 site），只脱敏 meta', () => {
    const [row] = auditRows([{ log, actorEmail: 'a@example.test', site: 'second' }])
    expect(row).toEqual({
      actorEmail: 'a@example.test',
      site: 'second',
      log: {
        ...log,
        meta: {
          key: 'operations.telegramBotToken',
          oldValue: '[REDACTED]',
          newValue: '[REDACTED]',
        },
      },
    })
  })

  it('普通设置与非设置记录的 meta 不脱敏', () => {
    const plain = {
      ...log,
      targetId: 'site.announcement',
      meta: { key: 'site.announcement', oldValue: 'a' },
    }
    expect(auditRows([{ log: plain, actorEmail: null }])[0]?.log.meta).toEqual(plain.meta)
  })
})
