import { execFileSync } from 'node:child_process'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))

export function nodeMapTargets(root) {
  return [
    { directory: resolve(root, 'apps/web/.output/server'), dist: 'web-node' },
    { directory: resolve(root, 'apps/jobs/.output/server'), dist: 'jobs-node' },
  ]
}

async function removePublicMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await removePublicMaps(path)
    else if (entry.name.endsWith('.map')) await rm(path)
  }
}

/** 只有显式 upload 才取得上传凭据；本地 inject 不读取部署密钥，也不联系 Sentry。 */
export async function prepareNodeMaps({
  root = repository,
  release,
  upload = false,
  env = process.env,
  run = (args, environment) =>
    execFileSync('pnpm', ['exec', 'sentry-cli', ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    }),
}) {
  if (!/^[a-f0-9]{40}$/.test(release ?? ''))
    throw new Error('SENTRY_RELEASE must be a full git SHA')
  const targets = nodeMapTargets(root)
  for (const target of targets) {
    const metadata = JSON.parse(
      await readFile(resolve(target.directory, '../node-build.json'), 'utf8'),
    )
    if (metadata.release !== release || metadata.dist !== target.dist)
      throw new Error(`Node build metadata mismatch: ${target.dist}`)
    await stat(resolve(target.directory, 'index.mjs.map'))
  }
  const environment = { ...env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SENTRY_')) delete environment[key]
  }
  const uploadEnvironment = { ...environment }
  if (upload) {
    for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
      if (!env[key]) throw new Error(`Missing ${key}`)
      uploadEnvironment[key] = env[key]
    }
    run(['releases', 'new', release], uploadEnvironment)
  }
  for (const target of targets) {
    run(['sourcemaps', 'inject', target.directory], environment)
    if (upload)
      run(
        [
          'sourcemaps',
          'upload',
          '--release',
          release,
          '--dist',
          target.dist,
          '--validate',
          '--strict',
          '--wait',
          target.directory,
        ],
        uploadEnvironment,
      )
  }
  await removePublicMaps(resolve(root, 'apps/web/.output/public'))
  if (upload) run(['releases', 'finalize', release], uploadEnvironment)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const upload = process.argv.includes('--upload')
  const release =
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: 上传脚本在 Turbo 缓存之外执行。
    process.env.SENTRY_RELEASE ??
    process.env.APP_VERSION ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  await prepareNodeMaps({ release, upload })
}
