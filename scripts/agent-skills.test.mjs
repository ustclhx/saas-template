import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

// 项目级技能（agent-skills spec「双目录技能入口」）；OpenSpec 技能保留各 agent 的语法差异，不在此列
const SKILLS = [
  'quick-start',
  'deploy-cloudflare',
  'deploy-selfhost',
  'new-page',
  'new-module',
  'new-static-page',
  'add-ai-model',
  'security-scan',
  'template-sync',
  'ui-design',
]
const ROOT = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const skill = (name) => read(`.agents/skills/${name}/SKILL.md`)

test('两处目录的技能逐字节一致，且有 name 与 description', () => {
  for (const name of SKILLS) {
    const codex = readFileSync(join(ROOT, '.agents/skills', name, 'SKILL.md'))
    const claude = readFileSync(join(ROOT, '.claude/skills', name, 'SKILL.md'))
    assert.ok(codex.equals(claude), `${name} 两处内容不一致`)
    const front = codex.toString('utf8').match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(front, `${name} 缺少 frontmatter`)
    assert.match(front[1], new RegExp(`^name: ${name}$`, 'm'))
    assert.match(front[1], /^description: \S/m)
  }
})

test('技能引用的文档与相对链接在仓库中存在', () => {
  for (const name of SKILLS) {
    const text = skill(name)
    for (const [path] of text.matchAll(/(?<![\w/.-])docs\/[\w./-]+\.md/g)) {
      assert.ok(existsSync(join(ROOT, path)), `${name} 引用不存在的文档：${path}`)
    }
    const dir = join(ROOT, '.agents/skills', name)
    for (const [, link] of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
      assert.ok(existsSync(resolve(dir, link)), `${name} 链接不存在：${link}`)
    }
  }
})

// 核对命令在 template-only 块中，生成副本（有 .template-base.json）不包含它
const derived = existsSync(join(ROOT, '.template-base.json'))

test('维护说明的一致性核对命令覆盖全部技能', { skip: derived }, () => {
  const loop = read('docs/create-project.md').match(/for skill in ([^;]+); do/)
  assert.ok(loop, 'docs/create-project.md 缺少核对命令')
  assert.deepEqual(loop[1].trim().split(/\s+/), SKILLS)
  for (const name of SKILLS) {
    assert.match(read('docs/create-project.md'), new RegExp(`\\[${name}\\]\\(`))
  }
})

test('页面技能第 1 步检查设计稿，缺失时转入 ui-design', () => {
  for (const name of ['new-page', 'new-static-page']) {
    const first = skill(name).split(/\n## 2\./)[0]
    assert.match(first, /## 1\. 检查设计稿/, `${name} 第 1 步未检查设计稿`)
    assert.match(first, /`ui-design`/)
    assert.match(first, /不创建路由或组件文件/)
    assert.match(first, /docs\/design-system\.md/)
  }
})

test('ui-design 覆盖设计关卡要素，template-sync 覆盖 UI 截图对比', () => {
  const ui = skill('ui-design')
  for (const pattern of [
    /免设计稿|\*\*免\*\*/,
    /不向使用者索取视觉参考/,
    /brand\.css/,
    /data-site/,
    /桌面.*移动.*浅色.*深色.*正常.*空.*加载.*错误/,
    /明确表示「确认」/,
    /docs\/design\/prototypes\//,
    /docs\/design-system\/prototypes\//,
    /OpenSpec/,
    /`@[\w-]+\/ui` 与 `@[\w-]+\/ui\/project`/,
    /缺组件先补组件/,
  ]) {
    assert.match(ui, pattern)
  }
  const sync = skill('template-sync')
  assert.match(sync, /UI 截图对比/)
  assert.match(sync, /-- packages\/ui apps\/web\/src\/styles/)
  assert.match(sync, /不修改模板组件与基线 token/)
})

test('设计规范文档存在并记录镜像与同步提交字段', () => {
  const doc = read('docs/design-system.md')
  assert.match(doc, /\| Design System 镜像 \|/)
  assert.match(doc, /\| 最近同步提交 \|/)
  for (const [, link] of doc.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
    assert.ok(existsSync(resolve(ROOT, 'docs', link)), `docs/design-system.md 链接不存在：${link}`)
  }
})
