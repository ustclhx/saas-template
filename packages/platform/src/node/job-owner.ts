import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'

export interface ProcessOwner {
  readonly pid: number
  readonly host: string
  readonly pidNamespace: string
  readonly token: string
  // 旧版本记录没有这两项；不能凭缺少身份信息接管仍存活的 PID。
  readonly bootId?: string
  readonly startTime?: string
}

async function processStartTime(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  // comm 可以含空格和括号，最后一个 ')' 之后才是从 field 3 开始的字段。
  const end = value.lastIndexOf(')')
  const fields = value
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  const startTime = fields[19]
  if (!value.startsWith(`${pid} (`) || end < 0 || !startTime || !/^\d+$/.test(startTime))
    throw new Error('Invalid Linux process identity')
  return startTime
}

export async function processOwner(): Promise<ProcessOwner> {
  const base = { pid: process.pid, host: hostname(), token: randomUUID() }
  if (process.platform !== 'linux') return { ...base, pidNamespace: 'host' }
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId))
    throw new Error('Invalid Linux boot identity')
  const namespace = await stat('/proc/self/ns/pid')
  if (!Number.isSafeInteger(namespace.ino) || namespace.ino <= 0)
    throw new Error('Invalid Linux PID namespace')
  return {
    ...base,
    pidNamespace: String(namespace.ino),
    bootId,
    startTime: await processStartTime(process.pid),
  }
}

function pidExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'
  }
}

export async function processExited(owner: ProcessOwner, current: ProcessOwner): Promise<boolean> {
  if (owner.host !== current.host) return false
  if (process.platform === 'linux') {
    // 损坏的旧 namespace 不是重启证明；旧 Linux 记录也必须是有效 inode。
    if (!/^[1-9]\d*$/.test(owner.pidNamespace) || !Number.isSafeInteger(Number(owner.pidNamespace)))
      return false
    // 同一 hostname 的容器重启可能复用 PID 1；boot/namespace 变化证明旧 incarnation 已退出。
    if (!current.bootId || !current.startTime) return false
    if (owner.bootId && owner.bootId !== current.bootId) return true
    if (owner.pidNamespace !== current.pidNamespace) return true
    try {
      const startTime = await processStartTime(owner.pid)
      return owner.startTime !== undefined && owner.startTime !== startTime
    } catch (error) {
      // hidepid 等挂载选项也可能隐藏活 PID；/proc 缺失必须再由 ESRCH 确认。
      return (
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT' &&
        pidExited(owner.pid)
      )
    }
  }
  if (owner.pidNamespace !== current.pidNamespace) return false
  return pidExited(owner.pid)
}
