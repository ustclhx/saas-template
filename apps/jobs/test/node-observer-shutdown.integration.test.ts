import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, jobMessage } from '@saas/db'
import type { EmailQueueMessage } from '@saas/email/queue'
import { createNodeQueueProducer } from '@saas/platform/node'
import { newId } from '@saas/shared'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'

it.each(['reachable', 'unreachable', 'disabled'] as const)(
  'captures a real SMTP failure then SIGTERM keeps the original deadline with %s observation',
  async (mode) => {
    const databaseUrl = process.env.TEST_JOB_DATABASE_URL
    const valkeyUrl = process.env.TEST_VALKEY_URL
    const smtpPort = process.env.JOBS_SMTP_PORT
    if (!databaseUrl || !valkeyUrl || !smtpPort) throw new Error('Isolated jobs fixtures required')
    const root = fileURLToPath(new URL('../', import.meta.url))
    await mkdir(join(root, '.output'), { recursive: true })
    const directory = await mkdtemp(join(root, '.output/shutdown-test-'))
    const db = createDb(databaseUrl, { max: 1 })
    const id = newId()
    let envelopes = 0
    const sockets = new Set<Socket>()
    const receiver = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      envelopes++
      if (mode === 'reachable') response.end('{}')
      // 不可达用已经接受但从不回应的transport，确保shutdown时仍有实际待发事件。
    })
    receiver.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    const receiverPort = (receiver.address() as AddressInfo).port
    const listener = createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const jobsPort = (listener.address() as AddressInfo).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    execFileSync(process.execPath, ['scripts/build-node.mjs', directory], {
      cwd: root,
      stdio: 'pipe',
    })
    const child = spawn(process.execPath, [join(directory, 'server/index.mjs')], {
      cwd: directory,
      env: {
        DATABASE_URL: databaseUrl,
        VALKEY_URL: valkeyUrl,
        BETTER_AUTH_SECRET: 'jobs-shutdown-fixture-at-least-32-characters',
        APP_URL: 'https://example.com',
        GOOGLE_CLIENT_ID: 'fixture',
        GOOGLE_CLIENT_SECRET: 'fixture',
        GITHUB_CLIENT_ID: 'fixture',
        GITHUB_CLIENT_SECRET: 'fixture',
        TURNSTILE_SITE_KEY: 'fixture',
        TURNSTILE_SECRET_KEY: 'fixture',
        HOST: '127.0.0.1',
        PORT: String(jobsPort),
        SHUTDOWN_TIMEOUT_MS: '1000',
        JOB_EXECUTOR_ID: `observer-${id}`,
        JOB_OWNERSHIP_DIRECTORY: join(directory, 'owners'),
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: smtpPort,
        SMTP_TLS_MODE: 'none',
        EMAIL_FROM: 'fixture@example.com',
        ...(mode === 'disabled'
          ? {}
          : {
              SENTRY_DSN: `http://fixture@127.0.0.1:${receiverPort}/1`,
              SENTRY_ENVIRONMENT: 'smoke',
            }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        output += String(data)
      })
    async function until(check: () => boolean, limit = 15_000) {
      const deadline = Date.now() + limit
      while (!check()) {
        if (child.exitCode !== null)
          throw new Error('Jobs observer child exited before expected lifecycle')
        if (Date.now() >= deadline) throw new Error('Jobs observer child fixture timed out')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    try {
      await until(() => output.includes('jobs.node.started'))
      const producer = createNodeQueueProducer<EmailQueueMessage>(db, 'email').producer
      await producer.send({
        v: 1,
        template: 'otp',
        to: 'permanent@example.com',
        appName: 'Fixture',
        props: { otp: '123456', purpose: 'sign-in', expiresInMinutes: 5 },
        idempotencyKey: `shutdown-${id}`,
        requestId: `shutdown-${id}`,
      })
      await until(() => output.includes('email.failed'))
      if (mode !== 'disabled') await until(() => envelopes > 0)
      const stoppedAt = Date.now()
      child.kill('SIGTERM')
      const [code, signal] = await exited
      expect(signal).toBeNull()
      expect(code).toBe(0)
      expect(Date.now() - stoppedAt).toBeLessThan(1_700)
      expect(output).toContain('jobs.node.stopped')
      const [message] = await db
        .select()
        .from(jobMessage)
        .where(eq(jobMessage.idempotencyKey, `shutdown-${id}`))
      expect(message?.state).toBe('dead')
      if (mode === 'disabled') expect(envelopes).toBe(0)
      else expect(envelopes).toBeGreaterThan(0)
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => receiver.close(() => resolve()))
      await db.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  25_000,
)
