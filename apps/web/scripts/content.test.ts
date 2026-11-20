import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createBuilder } from '@content-collections/core'
import { afterAll, describe, expect, it } from 'vitest'

// 草稿不进入生产构建（openspec add-marketing-i18n-seo tasks.md 3.3，specs/marketing-site「博客」）：
// 按生产构建的 NODE_ENV 生成内容到临时目录，检查生成的数据里没有草稿；开发环境则保留草稿供预览。
const configPath = new URL('../content-collections.ts', import.meta.url).pathname
const appRoot = new URL('..', import.meta.url).pathname
// 编译后的配置从这里解析依赖，临时目录需位于 apps/web 下（.content-collections 已 gitignore）
const tempRoot = new URL('../.content-collections/test', import.meta.url).pathname
const outputs: string[] = []

async function buildPosts(
  nodeEnv: string,
): Promise<
  { slug: string; draft: boolean; parent: string; related: string[]; _meta: { path: string } }[]
> {
  mkdirSync(tempRoot, { recursive: true })
  const outputDir = mkdtempSync(join(tempRoot, 'build-'))
  outputs.push(outputDir)
  // 构建真实集合配置的临时副本，只固定博客开关；不改生成项目本身的配置。
  const fixturePath = join(outputDir, 'content-collections.ts')
  const fixture = readFileSync(configPath, 'utf8')
    .replace(
      "import templateConfig from '../../template.config.ts'",
      `import { defineTemplateConfig } from '@saas/config'
const templateConfig = defineTemplateConfig({
  app: { name: 'Content test', url: 'https://content.example', supportEmail: 'support@content.example' },
  features: { blog: true },
})`,
    )
    .replaceAll("directory: 'content/", `directory: '${relative(outputDir, appRoot)}/content/`)
    .replaceAll("from './src/", `from '${relative(outputDir, appRoot)}/src/`)
  writeFileSync(fixturePath, fixture)
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv
  try {
    const builder = await createBuilder(fixturePath, {
      configName: 'content-collection-config.mjs',
      outputDir,
      cacheDir: join(outputDir, 'cache'),
    })
    await builder.build()
  } finally {
    process.env.NODE_ENV = previous
  }
  const source = readFileSync(join(outputDir, 'allPosts.js'), 'utf8')
  return JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1))
}

afterAll(() => {
  for (const dir of outputs) rmSync(dir, { recursive: true, force: true })
})

// 断言按仓库里实际的博客源文件推出，衍生项目替换或删除示例文章后同样成立
const blogRoot = new URL('../content/blog', import.meta.url).pathname
const sources = new Map(
  readdirSync(blogRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.mdx'))
    .map((file) => {
      const text = readFileSync(join(blogRoot, file), 'utf8')
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      return [file.replace(/\.mdx$/, ''), front] as const
    }),
)
const drafts = [...sources].filter(([, front]) => /^draft:\s*true\s*$/m.test(front))

describe('博客草稿', () => {
  it('生产构建中不包含草稿', async () => {
    const posts = await buildPosts('production')
    expect(posts.filter((post) => post.draft)).toEqual([])
    const draftPaths = new Set(drafts.map(([path]) => path))
    expect(posts.filter((post) => draftPaths.has(post._meta.path))).toEqual([])
    // 内链字段（seo-internal-linking 1.3）：未写 parent 时取集合的列表页，未写 related 时为空
    for (const post of posts) {
      const front = sources.get(post._meta.path) ?? ''
      if (!/^parent:/m.test(front)) expect(post.parent).toBe('/blog')
      if (!/^related:/m.test(front)) expect(post.related).toEqual([])
      else expect(post.related.length).toBeGreaterThan(0)
    }
  })

  it.skipIf(drafts.length === 0)('开发环境保留草稿供预览', async () => {
    const posts = await buildPosts('development')
    const paths = posts.filter((post) => post.draft).map((post) => post._meta.path)
    expect(paths.sort()).toEqual(drafts.map(([path]) => path).sort())
  })
})
