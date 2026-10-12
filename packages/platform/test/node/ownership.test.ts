import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProcessOwner, processExited, processOwner } from '../../src/node/job-owner.ts'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
if (!platform) throw new Error('Process platform descriptor required')
const bootId = 'c5617dba-a32f-4032-9bcb-3e04fe1a8c18'
const current: ProcessOwner = {
  pid: 1,
  host: 'jobs-host',
  pidNamespace: '4026533001',
  token: 'current-token',
  bootId,
  startTime: '1000',
}
const previous: ProcessOwner = { ...current, token: 'previous-token' }
// /proc stat 的 field 22 是从 state（field 3）起的第 20 项。
const procStat = (pid: number, startTime: string) =>
  `${pid} (job (worker) name) S ${Array(18).fill('0').join(' ')} ${startTime} 0 0\n`

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.mocked(readFile).mockResolvedValue(procStat(1, '1000'))
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('Node executor incarnation ownership', () => {
  it('captures boot, namespace and start time even when comm contains spaces and parentheses', async () => {
    vi.mocked(readFile).mockImplementation(async (path) =>
      path === '/proc/sys/kernel/random/boot_id'
        ? `${bootId}\n`
        : procStat(process.pid, '987654321'),
    )
    vi.mocked(stat).mockResolvedValue({ ino: 4026533001 } as Awaited<ReturnType<typeof stat>>)
    expect(await processOwner()).toMatchObject({
      pid: process.pid,
      bootId,
      pidNamespace: '4026533001',
      startTime: '987654321',
    })
  })

  it('proves a same-host container restart despite reusing PID 1', async () => {
    expect(await processExited({ ...previous, pidNamespace: '4026532999' }, current)).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('proves a host reboot even when the namespace and PID numbers are reused', async () => {
    expect(
      await processExited({ ...previous, bootId: 'e887606c-377a-4a0e-afaf-cb8d10074546' }, current),
    ).toBe(true)
  })

  it('distinguishes a reused PID from its still-live old incarnation', async () => {
    expect(await processExited(previous, current)).toBe(false)
    vi.mocked(readFile).mockResolvedValue(procStat(1, '2000'))
    expect(await processExited(previous, current)).toBe(true)
  })

  it('refuses to infer exit on another hostname', async () => {
    expect(await processExited({ ...previous, host: 'other-host' }, current)).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('keeps a legacy live PID owned and permits recovery only once that PID is absent', async () => {
    const { bootId: _bootId, startTime: _startTime, ...legacy } = previous
    expect(await processExited(legacy, current)).toBe(false)
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(await processExited(legacy, current)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' })
    })
    expect(await processExited(legacy, current)).toBe(true)
  })

  it('fails closed when process proof is unreadable or malformed', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: 'EACCES' }))
    expect(await processExited(previous, current)).toBe(false)
    vi.mocked(readFile).mockResolvedValue('unparseable')
    expect(await processExited(previous, current)).toBe(false)
  })

  it('refuses Linux startup without a reliable boot identity', async () => {
    vi.mocked(readFile).mockResolvedValue('not-a-boot-id')
    await expect(processOwner()).rejects.toThrow('Invalid Linux boot identity')
  })

  it('retains ESRCH-only exit proof on non-Linux hosts', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const hostOwner = { ...previous, pidNamespace: 'host' }
    const hostCurrent = { ...current, pidNamespace: 'host' }
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(await processExited(hostOwner, hostCurrent)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EPERM' })
    })
    expect(await processExited(hostOwner, hostCurrent)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' })
    })
    expect(await processExited(hostOwner, hostCurrent)).toBe(true)
  })
})
