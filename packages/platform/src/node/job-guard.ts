import { spawn } from 'node:child_process'
import { AppError } from '@saas/shared'

/** 只保护初始化的文件临界区；运行中的执行者仍由其真实进程身份和 DB 锁保护。 */
export async function acquireNodeJobGuard(path: string): Promise<() => Promise<void>> {
  if (process.platform !== 'linux') return async () => {}
  const child = spawn('flock', ['-n', path, 'sh', '-c', "printf 'ready\\n'; cat >/dev/null"], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const failure = () =>
    new AppError('JOB_ENGINE_EXECUTOR_IN_USE', 'Node job engine initialization is unavailable', {
      status: 503,
    })
  let ready = false
  let output = ''
  let rejectReady: (error: Error) => void = () => {}
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  // 子进程诊断不进入业务日志；stdin 的 EPIPE 也必须处理。
  child.stderr.resume()
  child.stdin.on('error', () => rejectReady(failure()))
  child.on('error', () => rejectReady(failure()))
  const acquired = new Promise<void>((resolve, reject) => {
    rejectReady = reject
    child.once('close', () => {
      if (!ready) reject(failure())
    })
    child.stdout.on('data', (value) => {
      if (ready) return
      output += String(value)
      if (output === 'ready\n') {
        ready = true
        resolve()
      }
    })
  })
  try {
    await acquired
  } catch (error) {
    child.stdin.end()
    await exited
    throw error
  }
  return async () => {
    // 父进程被 SIGKILL 时 pipe 自动 EOF，同样使 cat/flock 真正退出并释放内核锁。
    child.stdin.end()
    await exited
  }
}
