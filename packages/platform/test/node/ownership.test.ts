import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireNodeJobGuard } from '../../src/node/job-guard.ts'
import { type ProcessOwner, processExited, processOwner } from '../../src/node/job-owner.ts'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
if (!platform) throw new Error('Process platform descriptor required')
const bootId = 'c5617dba-a32f-4032-9bcb-3e04fe1a8c18'
const machineId = 'fac4633b0e7e4cfe97c7b3b983e8cf86'
const current: ProcessOwner = {
  pid: 1,
  host: 'jobs-host',
  pidNamespace: '4026533001',
  token: 'current-token',
  machineId,
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

describe.runIf(process.platform === 'linux')('Linux initialization kernel guard', () => {
  it('excludes a concurrent initializer and releases the kernel lock when its pipe closes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-guard-'))
    const path = join(directory, 'owner.lock')
    let release: (() => Promise<void>) | undefined
    try {
      release = await acquireNodeJobGuard(path)
      await expect(acquireNodeJobGuard(path)).rejects.toMatchObject({
        code: 'JOB_ENGINE_EXECUTOR_IN_USE',
      })
      await release()
      release = await acquireNodeJobGuard(path)
    } finally {
      await release?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('releases the kernel lock after its Node parent is really killed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-guard-exit-'))
    const path = join(directory, 'owner.lock')
    const helper = fileURLToPath(new URL('../../src/node/job-guard.ts', import.meta.url))
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const { acquireNodeJobGuard } = await import(${JSON.stringify(helper)}); await acquireNodeJobGuard(process.argv[1]); process.stdout.write('held\\n')`,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.stderr.resume()
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', () => reject(new Error('Guard parent exited before acquiring lock')))
        child.stdout.once('data', (value) => {
          if (String(value) === 'held\n') resolve()
          else reject(new Error('Unexpected guard parent output'))
        })
      })
      await expect(acquireNodeJobGuard(path)).rejects.toMatchObject({
        code: 'JOB_ENGINE_EXECUTOR_IN_USE',
      })
      child.kill('SIGKILL')
      await exited
      let release: (() => Promise<void>) | undefined
      // Node exit 之后，独立的 cat/flock 还需得到调度，实际锁释放不能靠固定 sleep 猜测。
      await expect
        .poll(async () => {
          try {
            release = await acquireNodeJobGuard(path)
            return true
          } catch {
            return false
          }
        })
        .toBe(true)
      await release?.()
    } finally {
      child.kill('SIGKILL')
      await exited
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

describe('Node executor incarnation ownership', () => {
  it('captures trusted host, boot, namespace and start time even when comm contains spaces and parentheses', async () => {
    vi.stubEnv('JOB_HOST_ID_FILE', '/run/job-host/machine-id')
    vi.mocked(readFile).mockImplementation(async (path) =>
      path === '/run/job-host/machine-id'
        ? `${machineId}\n`
        : path === '/proc/sys/kernel/random/boot_id'
          ? `${bootId}\n`
          : procStat(process.pid, '987654321'),
    )
    vi.mocked(stat).mockResolvedValue({ ino: 4026533001 } as Awaited<ReturnType<typeof stat>>)
    expect(await processOwner()).toMatchObject({
      pid: process.pid,
      machineId,
      bootId,
      pidNamespace: '4026533001',
      startTime: '987654321',
    })
  })

  it('refuses another PID namespace because its old container can still be alive', async () => {
    expect(await processExited({ ...previous, pidNamespace: '4026532999' }, current)).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('proves a host reboot even when the namespace and PID numbers are reused', async () => {
    expect(
      await processExited({ ...previous, bootId: 'e887606c-377a-4a0e-afaf-cb8d10074546' }, current),
    ).toBe(true)
  })

  it('refuses a different machine even when hostname matches and boot changes', async () => {
    expect(
      await processExited(
        {
          ...previous,
          machineId: '04e1a5188f9743f2b8d0a355a96c1c0a',
          bootId: 'e887606c-377a-4a0e-afaf-cb8d10074546',
        },
        current,
      ),
    ).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('refuses a damaged namespace instead of treating it as a container restart', async () => {
    for (const pidNamespace of ['', 'corrupt', '0', '9007199254740992'])
      expect(await processExited({ ...previous, pidNamespace }, current)).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
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

  it('requires ENOENT and ESRCH together before proving a process exited', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(await processExited(previous, current)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' })
    })
    expect(await processExited(previous, current)).toBe(true)
  })

  it('refuses a legacy Linux owner without machine identity even when its PID is absent', async () => {
    const { machineId: _machineId, ...legacy } = previous
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' })
    })
    expect(await processExited(legacy, current)).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('fails closed when process proof is unreadable or malformed', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: 'EACCES' }))
    expect(await processExited(previous, current)).toBe(false)
    vi.mocked(readFile).mockResolvedValue('unparseable')
    expect(await processExited(previous, current)).toBe(false)
  })

  it('refuses Linux startup without a reliable boot identity', async () => {
    vi.mocked(readFile).mockImplementation(async (path) =>
      path === (process.env.JOB_HOST_ID_FILE ?? '/etc/machine-id') ? machineId : 'not-a-boot-id',
    )
    await expect(processOwner()).rejects.toThrow('Invalid Linux boot identity')
  })

  it('refuses Linux startup without a valid host machine identity', async () => {
    for (const value of ['not-a-machine-id', '0'.repeat(32)]) {
      vi.mocked(readFile).mockResolvedValue(value)
      await expect(processOwner()).rejects.toThrow('Invalid Linux host identity')
    }
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
