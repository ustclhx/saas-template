import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'

export interface ProcessOwner {
  readonly pid: number
  readonly host: string
  readonly pidNamespace: string
  readonly token: string
  // 旧 Linux 记录缺宿主身份时必须人工核验迁移，不能用新机 boot ID 猜测旧机退出。
  readonly machineId?: string
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
  const machineId = (await readFile(process.env.JOB_HOST_ID_FILE ?? '/etc/machine-id', 'utf8'))
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(machineId) || /^0+$/.test(machineId))
    throw new Error('Invalid Linux host identity')
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId))
    throw new Error('Invalid Linux boot identity')
  const namespace = await stat('/proc/self/ns/pid')
  if (!Number.isSafeInteger(namespace.ino) || namespace.ino <= 0)
    throw new Error('Invalid Linux PID namespace')
  return {
    ...base,
    machineId,
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
    // hostname 可被异机复用；只有可信宿主身份相同，boot 变化才证明旧宿主已重启。
    if (
      !owner.machineId ||
      owner.machineId !== current.machineId ||
      !owner.bootId ||
      !current.bootId ||
      !current.startTime
    )
      return false
    if (owner.bootId !== current.bootId) return true
    // 不同 namespace 可以同时存活；selfhost 容器共享宿主 PID namespace 后才可查询旧 PID。
    if (owner.pidNamespace !== current.pidNamespace) return false
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
