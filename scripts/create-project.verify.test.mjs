import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProject, verifyProject } from './create-project.mjs'

// 显式运行的端到端自检：真正安装与检查完整副本，避免日常边界测试反复安装依赖。
test('真实模板生成的项目无原名称，类型检查与单元测试通过', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'bootstrap-verify-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const name = `validation-${process.pid.toString(36)}`
  const result = await createProject({
    name,
    domain: `${name}.example`,
    locale: 'zh',
    ai: 'text',
    target: join(temp, 'acme'),
  })
  let count = 0
  async function inspect(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      assert.ok(!path.includes(manifest.name), `原名称仍存在于路径：${path}`)
      if (entry.isDirectory()) {
        assert.ok(
          !['.git', 'node_modules', '.wrangler', 'dist', '.turbo', 'coverage'].includes(entry.name),
        )
        await inspect(path)
      } else {
        assert.ok(!entry.isSymbolicLink())
        const content = await readFile(path)
        if (!content.includes(0))
          assert.ok(!content.toString().includes(manifest.name), `原名称仍存在：${path}`)
        count++
      }
    }
  }
  await inspect(result.target)
  console.log(`已逐文件检查 ${count} 个文件，原名称与排除目录均不存在`)
  verifyProject(result.target)
})
