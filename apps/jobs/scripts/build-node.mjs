import { mkdir, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = resolve(root, process.argv[2] ?? '.output')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.node.ts'],
  outfile: `${output}/server/index.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  metafile: true,
  plugins: [
    {
      name: 'external-runtime-packages',
      setup(build) {
        // workspace 源码编译成 ESM；第三方依赖保持外置，允许它们加载原生 Node 模块。
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
          if (path.startsWith('@saas/')) return undefined
          if (path.startsWith('cloudflare:') || path.includes('@sentry/cloudflare'))
            throw new Error('Cloudflare dependency in Node jobs build')
          return { path, external: true }
        })
      },
    },
  ],
})
const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
const externals = [...new Set(imports.filter((item) => item.external).map((item) => item.path))]
if (externals.some((path) => /cloudflare:|workerd|@sentry\/cloudflare/.test(path)))
  throw new Error('Cloudflare dependency in Node jobs output')
const runtimePackages = externals.filter(
  (path) => !path.startsWith('node:') && !builtinModules.includes(path),
)
await mkdir(output, { recursive: true })
await writeFile(
  `${output}/node-build.json`,
  `${JSON.stringify({ externals: runtimePackages, inputs: Object.keys(result.metafile.inputs) }, null, 2)}\n`,
)
