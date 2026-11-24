import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import templateConfig from '../../../template.config.ts'

// 真实 esbuild 构建并启动 Node 子进程，CI 并发负载下会超过默认 5 秒。
it('loads jobs business code in real Node without Workers or Sentry CF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-node-load-'))
  const mediaEnabled = Boolean(templateConfig.plugins.media)
  try {
    const result = await build({
      entryPoints: {
        handlers: fileURLToPath(new URL('../src/handlers.ts', import.meta.url)),
        ...(mediaEnabled && {
          'media-runner': fileURLToPath(
            new URL('../../../plugins/media/src/jobs/media-runner.ts', import.meta.url),
          ),
        }),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outdir: dir,
      jsx: 'automatic',
      metafile: true,
      // 被 bundle 的第三方 CJS 仍需 Node require；不注入 Workers 全局或平台替身。
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
      logLevel: 'silent',
    })
    expect(JSON.stringify(result.metafile)).not.toMatch(/cloudflare:|@sentry\/cloudflare/)
    const script = `
      const handlers = await import(${JSON.stringify(join(dir, 'handlers.js'))});
      if (typeof handlers.consumeJobsBatch !== 'function' || typeof handlers.runJobsSchedule !== 'function') throw new Error('Missing handlers');
      if (${mediaEnabled}) {
        const runner = await import(${JSON.stringify(join(dir, 'media-runner.js'))});
        if (typeof runner.runMediaTask !== 'function') throw new Error('Missing media runner');
      }
      console.log('loaded');
    `
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('loaded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
