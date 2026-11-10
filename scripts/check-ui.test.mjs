import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkWorkspace } from './check-deps.mjs'
import { checkUi, findingsOf } from './check-ui.mjs'
import { createProject } from './create-project.mjs'
import { componentHashes, writeComponentLock } from './ui-lock.mjs'

function workspace(t, files = {}, allow = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-ui-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (file, contents) => {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
  write('scripts/check-ui.allow.json', allow)
  write('packages/ui/components.lock.json', {})
  for (const [file, contents] of Object.entries(files)) write(file, contents)
  writeComponentLock(root)
  return { root, check: () => checkUi(root), write }
}

test('hex, rgb/rgba, hsl/hsla and oklch colors fail in attributes, styles and templates', () => {
  const findings = findingsOf(
    [
      'const view = <svg fill="#fff" stroke={"#12345678"} />',
      'const style = { color: "rgb(0 0 0)", background: "rgba(0, 0, 0, .5)" }',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 保留待解析源码中的模板插值。
      'const gradient = `linear-gradient(hsl(0 0% 0%), ${angle}, oklch(.5 .2 20))`',
      'const extra = "hsla(0, 0%, 0%, .5) #abcd #112233"',
    ].join('\n'),
  )
  assert.equal(findings.length, 9)
  assert.ok(findings.every(({ rule }) => rule === 'color-literal'))
  assert.equal(findings[0].line, 1)
  assert.equal(findings[2].line, 2)
})

test('arbitrary class values fail in plain, conditional, cn and template className expressions', () => {
  const findings = findingsOf(
    [
      'const a = <div className="w-[13px] hover:text-[#fff]" />',
      'const b = <div className={cn("md:max-w-[40rem]", active && "rounded-[3px]")} />',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 保留待解析源码中的模板插值。
      'const c = <div className={`p-[3px] ${active ? "h-[30px]" : "h-8"}`} />',
      'const d = <div className={cn({ "[mask-type:luminance]": active })} />',
    ].join('\n'),
  )
  assert.equal(findings.filter(({ rule }) => rule === 'arbitrary-class').length, 7)
  assert.equal(findings.filter(({ rule }) => rule === 'color-literal').length, 1)
})

test('native selects and browser dialogs fail and report positions', () => {
  const findings = findingsOf(
    [
      'const a = <><select /><select><option>A</option></select><Select /></>',
      'confirm("delete?"); alert("failed"); window.confirm("delete?"); window.alert("failed")',
      'globalThis.confirm("delete?"); self.alert("failed"); window["confirm"]("delete?")',
    ].join('\n'),
  )
  assert.equal(findings.filter(({ rule }) => rule === 'native-select').length, 2)
  assert.deepEqual(
    findings.filter(({ rule }) => rule === 'browser-dialog').map(({ value }) => value),
    [
      'confirm',
      'alert',
      'window.confirm',
      'window.alert',
      'globalThis.confirm',
      'self.alert',
      'window.confirm',
    ],
  )
  assert.ok(findings.every(({ line, column }) => line > 0 && column > 0))
})

test('className follows local style constants once, respecting scopes and cycles', () => {
  const findings = findingsOf(
    [
      'const style = "w-[13px]"; const alias = style;',
      'const a = <><div className={alias} /><div className={style} /></>;',
      'function panel() { const style = "h-[14px]"; return <div className={style} /> }',
      'const cycle = cycle; const b = <div className={cycle} />;',
    ].join('\n'),
  )
  assert.deepEqual(
    findings.map(({ value }) => value),
    ['w-[13px]', 'h-[14px]'],
  )
  assert.equal(findings[0].line, 1)
})

test('tokens, bracket variants, comments and local business functions pass', () => {
  assert.deepEqual(
    findingsOf(
      [
        '// confirm("delete"); <select /> #fff',
        '/* <div className="w-[13px]" /> */',
        'const example = "confirm(\'test\') <select> w-[13px]"',
        'const a = <div className="bg-primary text-muted-foreground aria-[current=page]:font-medium [&_form]:gap-4" />',
        'function billing() { function confirm() {} confirm() }',
        'function notice(alert: () => void) { alert() }',
        'const window = { confirm() {} }; window.confirm()',
        'function custom(globalThis: { alert(): void }, self: { confirm(): void }) { globalThis.alert(); self.confirm() }',
      ].join('\n'),
    ),
    [],
  )
  // 同名局部函数不能豁免其他作用域中的全局调用。
  assert.equal(
    findingsOf('function billing() { function confirm() {} confirm() } confirm()').length,
    1,
  )
})

test('all apps src TSX files are checked, excluding tests, generated files and packages', (t) => {
  const { check } = workspace(t, {
    'apps/web/src/route.tsx': '<select />',
    'apps/other/src/feature/panel.tsx': 'alert("bad")',
    'apps/web/src/page.test.tsx': '<select />',
    'apps/web/src/page.spec.tsx': '<select />',
    'apps/web/src/__tests__/page.tsx': '<select />',
    'apps/web/src/generated/page.tsx': '<select />',
    'apps/web/src/__generated__/page.tsx': '<select />',
    'apps/web/src/page.gen.tsx': '<select />',
    'apps/web/src/page.generated.tsx': '<select />',
    'apps/web/src/paraglide/page.tsx': '<select />',
    'apps/web/test/page.tsx': '<select />',
    'apps/web/src/og-card.ts': 'const color = "#fff"',
    'packages/ui/src/components/select.tsx': '<select />',
  })
  const result = check()
  assert.equal(result.files, 2)
  assert.equal(result.violations.length, 2)
  assert.deepEqual(result.violations.map(({ file }) => file).sort(), [
    'apps/other/src/feature/panel.tsx',
    'apps/web/src/route.tsx',
  ])
})

test('formal exceptions and optional project exceptions allow only the registered file and rule', (t) => {
  const file = 'apps/web/src/icon.tsx'
  const { check, write } = workspace(
    t,
    {
      [file]: '<svg fill="#fff" />',
      'apps/web/src/page.tsx': '<select />',
      'apps/web/src/other.tsx': '<svg fill="#fff" />',
    },
    {
      exceptions: { [file]: [{ rule: 'color-literal', reason: '第三方品牌色' }] },
    },
  )
  assert.equal(check().violations.length, 2)
  write('scripts/check-ui.allow.local.json', {
    exceptions: {
      'apps/web/src/other.tsx': [{ rule: 'color-literal', reason: '项目插画固定色' }],
    },
  })
  assert.equal(check().violations.length, 1)
  write(file, '<svg fill="#fff"><select /></svg>')
  assert.equal(check().violations.length, 2)
})

test('each violation category can be allowed by an explicit file and reason', (t) => {
  const cases = {
    'color-literal': '<div style={{ color: "#fff" }} />',
    'arbitrary-class': '<div className="w-[13px]" />',
    'native-select': '<select />',
    'browser-dialog': 'window.confirm("delete?")',
  }
  const files = {}
  const exceptions = {}
  for (const [rule, source] of Object.entries(cases)) {
    const file = `apps/web/src/${rule}.tsx`
    files[file] = source
    exceptions[file] = [{ rule, reason: '此夹具验证逐文件例外' }]
  }
  const { check, write } = workspace(t, files, { exceptions })
  assert.equal(check().violations.length, 0)
  write(
    'apps/web/src/unregistered.tsx',
    Object.values(cases)
      .map((source) => `${source};`)
      .join('\n'),
  )
  assert.equal(check().violations.length, 4)
})

test('pending replacement permits only registered values and counts, including from local config', (t) => {
  const file = 'apps/web/src/page.tsx'
  const { check, write } = workspace(
    t,
    { [file]: '<select />' },
    {
      pendingReplacement: {
        [file]: [{ rule: 'native-select', value: '<select>', count: 1, reason: '第 5 组迁移' }],
      },
    },
  )
  assert.equal(check().violations.length, 0)
  write(file, '<><select /><select /><div className="w-[13px]" /></>')
  assert.equal(check().violations.length, 2)
  write('scripts/check-ui.allow.local.json', {
    pendingReplacement: {
      [file]: [{ rule: 'arbitrary-class', value: 'w-[13px]', count: 1, reason: '项目迁移' }],
    },
  })
  assert.equal(check().violations.length, 1)
  write(file, '<div className="w-[14px]" />')
  assert.equal(check().violations.length, 1)
})

test('exception registrations require a reason and pending registrations require a value and count', (t) => {
  const { check, write } = workspace(t)
  for (const entry of [
    { rule: 'color-literal', reason: '' },
    { rule: 'unknown', reason: '说明' },
  ]) {
    write('scripts/check-ui.allow.json', { exceptions: { 'apps/web/src/icon.tsx': [entry] } })
    assert.throws(check, /有效规则、原因/)
  }
  write('scripts/check-ui.allow.json', {
    pendingReplacement: { 'apps/web/src/icon.tsx': [{ rule: 'color-literal', reason: '待替换' }] },
  })
  assert.throws(check, /待替换值\/数量/)
})

test('template component edits, additions, deletions and missing locks require regeneration', (t) => {
  const file = 'packages/ui/src/components/button.tsx'
  const { root, check, write } = workspace(t, { [file]: 'export const Button = () => <button />' })
  assert.equal(check().violations.length, 0)
  const original = readFileSync(join(root, 'packages/ui/components.lock.json'), 'utf8')
  writeComponentLock(root)
  assert.equal(readFileSync(join(root, 'packages/ui/components.lock.json'), 'utf8'), original)
  assert.match(componentHashes(root)['src/components/button.tsx'], /^[a-f0-9]{64}$/)
  write(file, 'export const Button = () => <button className="rounded" />')
  write('packages/ui/src/components/nested/card.tsx', 'export const Card = () => <article />')
  let violations = check().violations
  assert.equal(violations.length, 2)
  assert.ok(violations.every(({ value }) => value.includes('pnpm ui:lock')))
  writeComponentLock(root)
  assert.equal(check().violations.length, 0)
  unlinkSync(join(root, file))
  violations = check().violations
  assert.equal(violations[0].file, file)
  unlinkSync(join(root, 'packages/ui/components.lock.json'))
  assert.ok(check().violations.some(({ file }) => file.endsWith('components.lock.json')))
})

test('derived projects reject changed template components with ordered customization guidance', (t) => {
  const file = 'packages/ui/src/components/button.tsx'
  const { root, check, write } = workspace(t, { [file]: 'export const Button = () => <button />' })
  write('.template-base.json', {})
  assert.equal(check().violations.length, 0)
  write(file, 'export const Button = () => <button className="rounded" />')
  write('scripts/check-ui.allow.local.json', {
    exceptions: { [file]: [{ rule: 'color-literal', reason: '项目例外不能绕过组件指纹' }] },
  })
  const [violation] = check().violations
  assert.equal(violation.file, file)
  assert.match(violation.value, /token → ui 配置 → project 包装 → 复制到 project/)
  assert.match(violation.value, /docs\/design\/forks\.md/)
  assert.doesNotMatch(violation.value, /pnpm ui:lock/)
  assert.throws(() => writeComponentLock(root), /由模板维护/)
})

test('generated projects can export and use project components under UI and dependency checks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-project-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { target } = await createProject({
    name: 'renamed-ui-check',
    domain: 'project.example',
    output: join(dir, 'project'),
  })
  const manifest = JSON.parse(readFileSync(join(target, 'packages/ui/package.json'), 'utf8'))
  const uiPackage = manifest.name
  assert.equal(manifest.exports['./project'], './src/project/index.ts')
  const component = join(target, 'packages/ui/src/project/project-card.tsx')
  const source =
    'import { Card } from \'../components/card.tsx\'\nexport function ProjectCard() { return <Card className="bg-primary">Project</Card> }\n'
  writeFileSync(component, source)
  writeFileSync(
    join(target, 'packages/ui/src/project/index.ts'),
    "export { ProjectCard } from './project-card.tsx'\n",
  )
  mkdirSync(join(target, 'apps/web/src/components'), { recursive: true })
  writeFileSync(
    join(target, 'apps/web/src/components/project-example.tsx'),
    `import { ProjectCard } from '${uiPackage}/project'\nexport const Example = () => <ProjectCard />\n`,
  )
  assert.deepEqual(checkUi(target).violations, [])
  assert.deepEqual(checkWorkspace(target).violations, [])
  writeFileSync(component, `${source}\nexport const Illustration = () => <svg fill="#fff" />\n`)
  assert.equal(checkUi(target).violations[0].file, 'packages/ui/src/project/project-card.tsx')
  writeFileSync(
    join(target, 'scripts/check-ui.allow.local.json'),
    JSON.stringify({
      exceptions: {
        'packages/ui/src/project/project-card.tsx': [
          { rule: 'color-literal', reason: '项目插画固定颜色' },
        ],
      },
    }),
  )
  assert.deepEqual(checkUi(target).violations, [])
  writeFileSync(component, `${source}\nimport '${uiPackage.split('/')[0]}/platform/node'\n`)
  assert.ok(
    checkWorkspace(target).violations.some((message) =>
      message.includes('packages/ui/src/project/project-card.tsx'),
    ),
  )
})
