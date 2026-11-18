import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { localArchitectures } from './policy.mjs'

const root = resolve(import.meta.dirname, '../../..')
const [version, architecture, directory] = process.argv.slice(2)
if (
  !/^[a-f0-9]{40}$/.test(version ?? '') ||
  // 发布只用 amd64；arm64 保留给 Apple Silicon 本机构建，发布侧由 policy.architectures 拦截。
  !localArchitectures.includes(architecture) ||
  !directory
)
  throw new Error('Usage: build.mjs <fullSha> <amd64|arm64> <output-dir>')
const output = resolve(directory)
// 层缓存只在显式设置时启用（CI 设为 gha），本机默认不读写任何远端缓存。
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 此脚本由 Actions/本机直接执行，不进入 Turbo 缓存。
const cache = process.env.SELFHOST_BUILD_CACHE ?? ''
if (!['', 'gha'].includes(cache)) throw new Error('SELFHOST_BUILD_CACHE must be empty or gha')
// 每个镜像/架构独立 scope，避免共用 Dockerfile 的不同 target 互相覆盖缓存索引；
// 缓存只影响构建耗时，镜像仍以 --load 后的实际 ID、架构与 revision 标签为准，导出失败不阻断构建。
const cacheArgs = (name) =>
  cache === 'gha'
    ? [
        '--cache-from',
        `type=gha,scope=selfhost-${name}-${architecture}`,
        '--cache-to',
        `type=gha,mode=max,ignore-error=true,scope=selfhost-${name}-${architecture}`,
      ]
    : []
const catalog = JSON.parse(readFileSync(join(import.meta.dirname, 'catalog.json'), 'utf8'))
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.services) || !catalog.services.length)
  throw new Error('Invalid image catalog')
const services = [
  ...catalog.services,
  { name: 'native-smoke', dockerfile: 'deploy/selfhost/app.Dockerfile', target: 'native-smoke' },
]
mkdirSync(output, { recursive: true })
const images = []
for (const { name, dockerfile, target } of services) {
  if (
    !/^[a-z][a-z0-9-]*$/.test(name) ||
    !/^deploy\/selfhost\/[\w./-]+\.Dockerfile$/.test(dockerfile)
  )
    throw new Error('Invalid image catalog entry')
  const image = `local/selfhost/${name}:${version}`
  execFileSync(
    'docker',
    [
      'buildx',
      'build',
      '--load',
      // tar 交付只保留已测运行镜像，避免单平台 attestation 嵌套索引混入最终双平台集合。
      '--provenance=false',
      '--platform',
      `linux/${architecture}`,
      '-f',
      dockerfile,
      ...(target ? ['--target', target] : []),
      ...cacheArgs(name),
      '--build-arg',
      `APP_VERSION=${version}`,
      '--label',
      `org.opencontainers.image.revision=${version}`,
      '-t',
      image,
      root,
    ],
    { cwd: root, stdio: 'inherit' },
  )
  const [inspection] = JSON.parse(
    execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }),
  )
  if (
    inspection.Architecture !== architecture ||
    inspection.Os !== 'linux' ||
    inspection.Config.Labels?.['org.opencontainers.image.revision'] !== version
  )
    throw new Error(`${name}: image architecture/revision mismatch`)
  const archive = `${name}.tar`
  if (name === 'native-smoke') continue
  execFileSync('docker', ['save', '-o', join(output, archive), image], { stdio: 'inherit' })
  images.push({ name, image, archive, id: inspection.Id, architecture, revision: version })
}
writeFileSync(
  join(output, 'build.json'),
  `${JSON.stringify({ sha: version, arch: architecture, services: images }, null, 2)}\n`,
)
