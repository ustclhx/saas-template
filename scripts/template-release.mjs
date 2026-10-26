#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const headings = [
  '概要',
  '必须执行的动作',
  '配置变更',
  '数据库变更',
  '部署顺序',
  '验证',
  '回滚',
  '已知问题',
]
const paramKeys = new Set([
  'name',
  'domain',
  'support-email',
  'target',
  'image-namespace',
  'locale',
  'i18n',
  'marketing',
  'billing',
  'billing-enabled',
  'credits-enabled',
  'ai',
  'media-providers',
  'features',
  'oauth',
  'turnstile',
  'multi-tenant',
])
const migrationPath = /^packages\/db\/migrations\/[^/]+\.sql$/

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd()
}

function ancestor(base, target, cwd) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', base, target], {
    cwd,
    stdio: 'pipe',
  })
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`Cannot compare revisions ${base} and ${target}`)
  return result.status === 0
}

export function compareVersions(a, b) {
  const left = semver.exec(a)
  const right = semver.exec(b)
  if (!left || !right) throw new Error('Invalid SemVer comparison')
  for (let i = 1; i <= 3; i++)
    if (Number(left[i]) !== Number(right[i])) return Number(left[i]) - Number(right[i])
  if (left[4] === right[4]) return 0
  if (!left[4]) return 1
  if (!right[4]) return -1
  const lpre = left[4].split('.')
  const rpre = right[4].split('.')
  for (let i = 0; i < Math.max(lpre.length, rpre.length); i++) {
    if (lpre[i] === rpre[i]) continue
    if (lpre[i] === undefined) return -1
    if (rpre[i] === undefined) return 1
    const lnum = /^\d+$/.test(lpre[i])
    const rnum = /^\d+$/.test(rpre[i])
    if (lnum && rnum) return Number(lpre[i]) - Number(rpre[i])
    if (lnum !== rnum) return lnum ? -1 : 1
    return lpre[i] < rpre[i] ? -1 : 1
  }
  return 0
}

export function listReleases(cwd = process.cwd()) {
  return git(cwd, 'tag', '--list', 'template-v*')
    .split('\n')
    .filter(Boolean)
    .flatMap((tag) => {
      const version = tag.slice('template-v'.length)
      if (!semver.test(version)) return []
      const ref = `refs/tags/${tag}`
      if (git(cwd, 'cat-file', '-t', ref) !== 'tag') return []
      const commit = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd,
        encoding: 'utf8',
      })
      return commit.status === 0 ? [{ version, tag, commit: commit.stdout.trim() }] : []
    })
    .sort((a, b) => compareVersions(a.version, b.version))
}

export function releasesBetween(base, target, cwd = process.cwd()) {
  return listReleases(cwd).filter(
    (release) => !ancestor(release.commit, base, cwd) && ancestor(release.commit, target, cwd),
  )
}

function releaseRange(version, cwd, useTag = true) {
  if (!semver.test(version ?? '')) throw new Error('version must be a SemVer x.y.z without prefix')
  const releases = listReleases(cwd)
  const current = releases.find((release) => release.version === version)
  const target = useTag && current ? current.commit : git(cwd, 'rev-parse', 'HEAD')
  const previous = releases
    .filter((release) => release.version !== version && ancestor(release.commit, target, cwd))
    .at(-1)
  const base = previous?.commit ?? git(cwd, 'rev-parse', 'v0.1.3^{commit}')
  return {
    base,
    target,
    previous: previous?.version ?? 'v0.1.3',
    releases,
    tagged: Boolean(useTag && current),
  }
}

function scalar(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    return value.slice(1, -1)
  return value
}

export function parseUpgradeDoc(text) {
  const errors = []
  const frontmatter = {}
  const normalized = text.replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match) errors.push('Missing YAML frontmatter')
  for (const line of match?.[1].split('\n') ?? []) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line)
    if (!field) {
      errors.push(`Invalid frontmatter line: ${line}`)
      continue
    }
    if (Object.hasOwn(frontmatter, field[1]))
      errors.push(`Duplicate frontmatter field: ${field[1]}`)
    frontmatter[field[1]] = scalar(field[2])
  }
  const body = (match ? normalized.slice(match[0].length) : normalized).replace(
    /<!--[\s\S]*?-->/g,
    '',
  )
  const sections = {}
  const found = [...body.matchAll(/^##\s+(.+?)\s*$/gm)]
  if (found.map((item) => item[1]).join('|') !== headings.join('|'))
    errors.push(`Sections must be in order: ${headings.join(' / ')}`)
  for (let i = 0; i < found.length; i++) {
    const title = found[i][1]
    sections[title] = body
      .slice(found[i].index + found[i][0].length, found[i + 1]?.index ?? body.length)
      .trim()
    if (!sections[title]) errors.push(`Empty section ${title}; write 无`)
  }
  const actions = []
  const actionSection = sections.必须执行的动作 ?? ''
  if (actionSection && actionSection !== '无') {
    const items = [...actionSection.matchAll(/^(\d+)[.)]\s+(.+)(?:\n(?!\d+[.)]\s)[ \t]+.*)*/gm)]
    if (
      !items.length ||
      actionSection.replace(/^(\d+)[.)]\s+(.+)(?:\n(?!\d+[.)]\s)[ \t]+.*)*/gm, '').trim()
    )
      errors.push('必须执行的动作 must be an ordered list or 无')
    for (let i = 0; i < items.length; i++) {
      if (Number(items[i][1]) !== i + 1)
        errors.push('Actions must be numbered consecutively from 1')
      let action = items[i][0].replace(/^\d+[.)]\s+/, '').trim()
      const conditions = {}
      const condition = /[（(]适用[：:]\s*([^）)]*)[）)]\s*$/.exec(action)
      if (condition) {
        action = action.slice(0, condition.index).trim()
        for (const part of condition[1].split(/[;；]/)) {
          const pair = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*([^=]+?)\s*$/.exec(part)
          if (!pair || !paramKeys.has(pair[1]) || Object.hasOwn(conditions, pair[1]))
            errors.push(`Invalid action condition: ${part.trim()}`)
          else conditions[pair[1]] = pair[2]
        }
      } else if (/[（(]适用[：:]/.test(action))
        errors.push('Action conditions must appear at the end')
      if (!action) errors.push('Action text must not be empty')
      actions.push({ text: action, conditions })
    }
  }
  const migrations = []
  const db = sections.数据库变更 ?? ''
  const migrationHeadings = [...db.matchAll(/^###\s+([^\n]+)$/gm)]
  if (db && db !== '无' && !migrationHeadings.length)
    errors.push('数据库变更 must list ### migration tags or 无')
  if (migrationHeadings.length && db.slice(0, migrationHeadings[0].index).trim())
    errors.push('Unexpected text before migration entries')
  for (let i = 0; i < migrationHeadings.length; i++) {
    const title = migrationHeadings[i][1].trim()
    const tag = title
    if (!/^[A-Za-z0-9_-]+$/.test(tag)) errors.push(`Invalid migration heading: ${title}`)
    const content = db.slice(
      migrationHeadings[i].index + migrationHeadings[i][0].length,
      migrationHeadings[i + 1]?.index ?? db.length,
    )
    const fields = {}
    for (const field of content.matchAll(
      /^-\s*(类别|兼容上一版本代码|锁表与耗时|回滚)[：:]\s*(.*?)\s*$/gm,
    )) {
      if (Object.hasOwn(fields, field[1]))
        errors.push(`Duplicate migration field: ${tag} ${field[1]}`)
      fields[field[1]] = field[2]
    }
    if (!['扩展', '收缩', '数据迁移'].includes(fields.类别)) errors.push(`${tag}: invalid 类别`)
    if (!['是', '否'].includes(fields.兼容上一版本代码))
      errors.push(`${tag}: invalid 兼容上一版本代码`)
    if (!fields.锁表与耗时 || !fields.回滚) errors.push(`${tag}: 锁表与耗时 and 回滚 are required`)
    migrations.push({
      tag,
      category: fields.类别,
      compatible: fields.兼容上一版本代码 === '是',
      lock: fields.锁表与耗时,
      rollback: fields.回滚,
    })
  }
  return { frontmatter, sections, actions, migrations, body, errors }
}

// 只切分语句和屏蔽字符串；分类仍用正则，不能替代数据库审阅或 Squawk。
export function classifyStatements(sql) {
  const statements = []
  let raw = ''
  let code = ''
  let comments = []
  const finish = () => {
    if (code.trim()) {
      const contraction =
        /\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b|\bRENAME\b|\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|[\w.]+)\s+(?:SET\s+DATA\s+)?TYPE\b|\bSET\s+NOT\s+NULL\b/i.test(
          code,
        ) ||
        [...code.matchAll(/\bADD\s+(?:COLUMN\s+)?([^,;]+)/gi)].some(
          (match) => /\bNOT\s+NULL\b/i.test(match[1]) && !/\bDEFAULT\b/i.test(match[1]),
        )
      const category = contraction
        ? '收缩'
        : /^\s*(?:UPDATE|DELETE|INSERT)\b/i.test(code)
          ? '数据迁移'
          : '扩展'
      const contractReason =
        comments
          .map((comment) =>
            /(?:^|\n)\s*--\s*template-contract:\s*([^\n]*\S[^\n]*)/i.exec(comment)?.[1]?.trim(),
          )
          .find(Boolean) ?? null
      statements.push({ sql: raw.trim(), category, contractReason })
    }
    raw = ''
    code = ''
    comments = []
  }
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i)
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i)
      const comment = sql.slice(i, end < 0 ? sql.length : end)
      comments.push(comment)
      raw += comment
      code += ' '
      i += comment.length
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2)
      const comment = sql.slice(i, end < 0 ? sql.length : end + 2)
      raw += comment
      code += ' '
      i += comment.length
    } else if (sql[i] === "'" || sql[i] === '"' || /^\$(?:[A-Za-z_]\w*)?\$/.test(rest)) {
      const delimiter =
        sql[i] === "'" || sql[i] === '"' ? sql[i] : /^\$(?:[A-Za-z_]\w*)?\$/.exec(rest)[0]
      let end = i + delimiter.length
      while (end < sql.length) {
        if (sql.startsWith(delimiter, end)) {
          if (delimiter.length === 1 && sql.startsWith(delimiter + delimiter, end)) {
            end += 2
            continue
          }
          end += delimiter.length
          break
        }
        if (delimiter === "'" && sql[end] === '\\') end++
        end++
      }
      const token = sql.slice(i, end)
      raw += token
      code += delimiter === '"' ? token : ' __literal__ '
      i = end
    } else if (sql[i] === ';') {
      raw += ';'
      code += ';'
      i++
      const inline = /^[ \t]*(--[^\n]*)/.exec(sql.slice(i))
      if (inline) {
        raw += inline[0]
        comments.push(inline[1])
        i += inline[0].length
      }
      finish()
    } else {
      raw += sql[i]
      code += sql[i]
      i++
    }
  }
  finish()
  return statements
}

function treeFiles(rev, cwd) {
  return git(cwd, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean)
}

function show(rev, path, cwd) {
  const result = spawnSync('git', ['show', `${rev}:${path}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status === 0) return result.stdout
  if (result.status === 128 && /(?:does not exist|exists on disk, but not in)/.test(result.stderr))
    return ''
  throw new Error(`Cannot read ${rev}:${path}`)
}

function changes(base, target, cwd) {
  return git(cwd, 'diff', '--name-status', '--no-renames', base, target)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t')
      return { status, path }
    })
}

function addedMigrations(base, target, cwd) {
  return changes(base, target, cwd)
    .filter(({ status, path }) => status === 'A' && migrationPath.test(path))
    .map(({ path }) => ({
      path,
      tag: path.split('/').at(-1).slice(0, -4),
      statements: classifyStatements(show(target, path, cwd)),
    }))
}

function immutableMigrations(base, target, cwd, releases = listReleases(cwd)) {
  const published = new Set(
    releases.flatMap((release) =>
      treeFiles(release.commit, cwd).filter((path) => migrationPath.test(path)),
    ),
  )
  return changes(base, target, cwd)
    .filter(({ status, path }) => status !== 'A' && migrationPath.test(path) && published.has(path))
    .map(({ path }) => `${path}: published migration cannot be modified or deleted`)
}

export function lintMigrations(base, cwd = process.cwd()) {
  if (!base) throw new Error('lint-migrations requires --base <revision>')
  const errors = immutableMigrations(base, 'HEAD', cwd)
  for (const migration of addedMigrations(base, 'HEAD', cwd)) {
    migration.statements.forEach((statement, i) => {
      if (statement.category === '收缩' && !statement.contractReason)
        errors.push(
          `${migration.path}: statement ${i + 1}: 收缩 requires -- template-contract: a nonempty reason and deployed version`,
        )
    })
  }
  return errors
}

function keys(text, regex) {
  return new Set([...text.matchAll(regex)].map((match) => match[1]))
}
function delta(before, after) {
  return {
    added: [...after].filter((key) => !before.has(key)).sort(),
    removed: [...before].filter((key) => !after.has(key)).sort(),
  }
}
function propertyLines(text) {
  const matches = [...text.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)(\?)?:[ \t]*([^\n]*)/gm)]
  return matches.map((match, index) => ({
    key: match[1],
    optional: Boolean(match[2]),
    // Zod 的 optional/default 常写在续行；不能把它们误判为新增必填项。
    value: text
      .slice(
        match.index + match[0].length - match[3].length,
        matches[index + 1]?.index ?? text.length,
      )
      .trim(),
  }))
}

function safeLine(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<resource-id>')
}

export function analyzeChanges(base, target, cwd = process.cwd()) {
  const files = changes(base, target, cwd)
  const details = []
  const breakingReasons = []
  const configFiles = new Set([
    'template.config.ts',
    ...treeFiles(target, cwd).filter(
      (path) => /^packages\/config\/src\/.*\.ts$/.test(path) && !path.endsWith('.test.ts'),
    ),
    ...treeFiles(base, cwd).filter(
      (path) => /^packages\/config\/src\/.*\.ts$/.test(path) && !path.endsWith('.test.ts'),
    ),
  ])
  for (const path of configFiles) {
    if (!files.some((file) => file.path === path)) continue
    const before = show(base, path, cwd)
    const after = show(target, path, cwd)
    const oldProps = propertyLines(before)
    const newProps = propertyLines(after)
    const names = delta(
      new Set(oldProps.map(({ key }) => key)),
      new Set(newProps.map(({ key }) => key)),
    )
    const required = newProps.filter(
      ({ key, optional, value }) =>
        /^[A-Z][A-Z0-9_]+$/.test(key) &&
        /^(?:z\.|secret\b|hyperdriveBinding\b)/.test(value) &&
        !oldProps.some((prop) => prop.key === key) &&
        !optional &&
        !/\.optional\(|\.default\(|\.prefault\(/.test(value) &&
        !value.startsWith('{'),
    )
    const becameRequired = newProps.filter(
      ({ key, optional, value }) =>
        /^[A-Z][A-Z0-9_]+$/.test(key) &&
        /^(?:z\.|secret\b|hyperdriveBinding\b)/.test(value) &&
        oldProps.some(
          (prop) =>
            prop.key === key && (prop.optional || /\.optional\(|\.default\(/.test(prop.value)),
        ) &&
        !optional &&
        !/\.optional\(|\.default\(/.test(value),
    )
    if (names.removed.length)
      breakingReasons.push(`${path}: removed configuration ${names.removed.join(', ')}`)
    if (required.length || becameRequired.length)
      breakingReasons.push(
        `${path}: required configuration ${[...required, ...becameRequired].map(({ key }) => key).join(', ')}`,
      )
    const env = delta(
      keys(before, /\b([A-Z][A-Z0-9_]+)\s*[:?]/g),
      keys(after, /\b([A-Z][A-Z0-9_]+)\s*[:?]/g),
    )
    details.push({
      path,
      kind: '配置类型 / 默认值 / 环境校验键',
      ...names,
      env,
      lines:
        files.find((file) => file.path === path)?.status === 'D'
          ? ['文件已删除']
          : git(cwd, 'diff', '--unified=0', base, target, '--', path)
              .split('\n')
              .filter((line) => /^[+-](?![+-])/.test(line))
              .map((line) =>
                /^[+-]\s*[A-Z][A-Z0-9_]*\s*:/.test(line)
                  ? `${line[0]} ${/^[-+]\s*([A-Z][A-Z0-9_]*)/.exec(line)[1]}（校验已变化）`
                  : safeLine(line),
              ),
    })
  }
  for (const path of ['apps/web/wrangler.jsonc', 'apps/jobs/wrangler.jsonc']) {
    const extract = (text) => {
      const clean = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
      const bindings = keys(clean, /["']binding["']\s*:\s*["']([^"']+)["']/g)
      // Rate Limiting 使用 name 声明绑定，不能与 Worker 或 Workflow 的资源名称混算。
      for (const section of clean.matchAll(/["']ratelimits["']\s*:\s*\[([^\]]*)\]/g))
        for (const name of keys(section[1], /["']name["']\s*:\s*["']([^"']+)["']/g))
          bindings.add(name)
      return bindings
    }
    const diff = delta(extract(show(base, path, cwd)), extract(show(target, path, cwd)))
    if (diff.added.length || diff.removed.length) {
      details.push({ path, kind: '部署绑定键', ...diff })
      breakingReasons.push(
        `${path}: deployment binding changes ${[...diff.added, ...diff.removed].join(', ')}`,
      )
    }
  }
  for (const path of new Set(
    [...treeFiles(base, cwd), ...treeFiles(target, cwd)].filter((path) =>
      /(?:^|\/)\.dev\.vars\.example$/.test(path),
    ),
  )) {
    const extract = (text) => keys(text, /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/gm)
    const diff = delta(extract(show(base, path, cwd)), extract(show(target, path, cwd)))
    if (diff.added.length || diff.removed.length) {
      details.push({ path, kind: '环境变量与密钥名称（不含值）', ...diff })
      breakingReasons.push(
        `${path}: environment/secret names ${[...diff.added, ...diff.removed].join(', ')}`,
      )
    }
  }
  const checklist = (text) => {
    const start = text.search(/(?:export\s+)?function\s+(?:selfhostChecklist|setupChecklist)\b/)
    if (start < 0) return new Set()
    const content = text.slice(
      start,
      text.indexOf('\nasync function replacements', start) < 0
        ? undefined
        : text.indexOf('\nasync function replacements', start),
    )
    return keys(content, /['"`]([^'"`\n]+)['"`]/g)
  }
  const checklistDiff = delta(
    checklist(show(base, 'scripts/create-project.mjs', cwd)),
    checklist(show(target, 'scripts/create-project.mjs', cwd)),
  )
  if (checklistDiff.added.length || checklistDiff.removed.length)
    details.push({
      path: 'scripts/create-project.mjs',
      kind: 'setupChecklist 清单项',
      added: checklistDiff.added.map(safeLine),
      removed: checklistDiff.removed.map(safeLine),
    })
  const dependencies = []
  for (const { path } of files.filter(({ path }) => /(?:^|\/)package\.json$/.test(path))) {
    const read = (rev) => JSON.parse(show(rev, path, cwd) || '{}')
    const before = read(base)
    const after = read(target)
    for (const group of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, value] of Object.entries(after[group] ?? {})) {
        const old = before[group]?.[name]
        const major = (spec) => /^(?:[~^]|>=?\s*)?(\d+)\./.exec(spec ?? '')?.[1]
        if (
          old &&
          major(old) !== undefined &&
          major(value) !== undefined &&
          major(old) !== major(value)
        )
          dependencies.push(`${path}: ${name} ${old} → ${value}`)
      }
      const removed = Object.keys(before[group] ?? {}).filter(
        (name) => !Object.hasOwn(after[group] ?? {}, name),
      )
      if (group === 'dependencies' && removed.length)
        breakingReasons.push(`${path}: removed dependencies ${removed.join(', ')}`)
    }
  }
  const commits = git(cwd, 'log', '--format=%s', `${base}..${target}`).split('\n').filter(Boolean)
  if (commits.some((subject) => /^[a-z]+(?:\([^)]*\))?!:/.test(subject)))
    breakingReasons.push('Conventional commit declares breaking change')
  const migrations = addedMigrations(base, target, cwd)
  if (
    migrations.some((migration) =>
      migration.statements.some((statement) => statement.category === '收缩'),
    )
  )
    breakingReasons.push('Contract migration')
  const removedCapabilities = files.filter(
    ({ status, path }) =>
      status === 'D' &&
      /^(?:packages\/[^/]+\/src\/|apps\/web\/src\/(?:routes|features)\/)/.test(path) &&
      !/\.(?:test|spec)\./.test(path),
  )
  if (removedCapabilities.length)
    breakingReasons.push(
      `Removed capabilities: ${removedCapabilities.map(({ path }) => path).join(', ')}`,
    )
  return {
    details,
    dependencies,
    commits,
    migrations,
    breakingReasons,
    feat: commits.some((subject) => /^feat(?:\([^)]*\))?!?:/.test(subject)),
  }
}

function expectedLevel(previous, breaking, feat) {
  const [major] = previous
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  return breaking ? (major === 0 ? 'MINOR' : 'MAJOR') : major >= 1 && feat ? 'MINOR' : 'PATCH'
}
function validBump(previous, version, level) {
  const old = previous
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  const next = version.split('.').map((part) => Number.parseInt(part, 10))
  if (old[0] === 0 && version === '1.0.0') return true
  if (compareVersions(version, previous.replace(/^v/, '')) <= 0) return false
  if (level === 'MAJOR') return next[0] > old[0] && next[1] === 0 && next[2] === 0
  if (level === 'MINOR') return next[0] === old[0] && next[1] > old[1] && next[2] === 0
  return next[0] === old[0] && next[1] === old[1] && next[2] > old[2]
}

export function checkRelease(version, cwd = process.cwd()) {
  const range = releaseRange(version, cwd)
  const document = readFileSync(join(cwd, `docs/upgrades/${version}.md`), 'utf8')
  const parsed = parseUpgradeDoc(document)
  const errors = [...parsed.errors]
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(document))
    errors.push('Upgrade text must not contain personal email addresses')
  if (/\b[0-9a-f]{32}\b/i.test(document))
    errors.push('Upgrade text must not contain production resource IDs')
  if (
    /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_]*\s*[=:]\s*["']?(?![<\s"'`])[^\s"'`]+/.test(
      document,
    )
  )
    errors.push('Upgrade text must contain secret names only, never secret values')
  const fm = parsed.frontmatter
  for (const key of Object.keys(fm))
    if (!['version', 'previous', 'date', 'breaking', 'requiresDeployed'].includes(key))
      errors.push(`Unknown frontmatter field: ${key}`)
  if (fm.version !== version || !semver.test(fm.version ?? ''))
    errors.push(`frontmatter version must be ${version}`)
  if (fm.previous !== range.previous) errors.push(`frontmatter previous must be ${range.previous}`)
  if (typeof fm.breaking !== 'boolean') errors.push('frontmatter breaking must be a boolean')
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(fm.date ?? '') ||
    Number.isNaN(Date.parse(`${fm.date}T00:00:00Z`)) ||
    new Date(`${fm.date}T00:00:00Z`).toISOString().slice(0, 10) !== fm.date
  )
    errors.push('frontmatter date must be a real YYYY-MM-DD date')
  if (fm.requiresDeployed !== undefined) {
    const deployed = range.releases.find((release) => release.version === fm.requiresDeployed)
    if (
      !semver.test(fm.requiresDeployed) ||
      !deployed ||
      compareVersions(fm.requiresDeployed, version) >= 0 ||
      !ancestor(deployed.commit, range.base, cwd)
    )
      errors.push('requiresDeployed must be an earlier published ancestor template version')
  }
  const analysis = analyzeChanges(range.base, range.target, cwd)
  const expected = analysis.migrations.map(({ tag }) => tag).sort()
  const actual = parsed.migrations.map(({ tag }) => tag).sort()
  if (expected.join('|') !== actual.join('|'))
    errors.push(`Migration list must exactly match: ${expected.join(', ') || '无'}`)
  for (const migration of parsed.migrations)
    if (!migration.compatible)
      errors.push(`${migration.tag}: migration must be compatible with previous version code`)
  const hasContract =
    analysis.migrations.some(({ statements }) =>
      statements.some(({ category }) => category === '收缩'),
    ) || parsed.migrations.some(({ category }) => category === '收缩')
  if (hasContract && !fm.requiresDeployed)
    errors.push('Contract migration requires requiresDeployed')
  for (const migration of analysis.migrations)
    for (const statement of migration.statements)
      if (statement.category === '收缩' && !statement.contractReason)
        errors.push(`${migration.tag}: contract statement requires -- template-contract: reason`)
  const breaking = parsed.actions.length > 0 || hasContract || analysis.breakingReasons.length > 0
  if (breaking && fm.breaking !== true)
    errors.push(
      `breaking must be true: ${analysis.breakingReasons.join('; ') || 'manual actions or contract migration'}`,
    )
  const level = expectedLevel(range.previous, fm.breaking === true || breaking, analysis.feat)
  if (!validBump(range.previous, version, level))
    errors.push(`${range.previous} → ${version} requires ${level} version increase`)
  // 只有早于本版本的发布才算「已发布」；本版本的 tag 存在后不能把区间内的修改算成修改自己。
  const published = range.releases.filter(
    (release) => release.version !== version && ancestor(release.commit, range.base, cwd),
  )
  errors.push(...immutableMigrations(range.base, range.target, cwd, published))
  const index = readFileSync(join(cwd, 'docs/upgrades/README.md'), 'utf8')
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (
    !index
      .split('\n')
      .some(
        (line) =>
          line.trimStart().startsWith('|') &&
          new RegExp(`\\[[^\\]]+\\]\\(\\.?/?${escapedVersion}\\.md\\)`).test(line),
      )
  )
    errors.push(`docs/upgrades/README.md must include a version index link for ${version}`)
  return errors
}

export function draftRelease(version, cwd = process.cwd()) {
  const range = releaseRange(version, cwd, false)
  const analysis = analyzeChanges(range.base, range.target, cwd)
  const level = expectedLevel(range.previous, analysis.breakingReasons.length > 0, analysis.feat)
  const grouped = new Map()
  for (const subject of analysis.commits) {
    const group = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject)?.[1] ?? 'other'
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group).push(subject)
  }
  const lines = [
    `# 模板 ${version} 发版草稿`,
    '',
    `区间：${range.previous} → HEAD`,
    `建议版本级别：${level}`,
    `不兼容：${analysis.breakingReasons.length > 0 ? '是' : '否'}`,
    ...analysis.breakingReasons.map((reason) => `- ${reason}`),
    '',
    '## 提交 / PR',
    '',
  ]
  for (const [group, subjects] of grouped)
    lines.push(`### ${group}`, '', ...subjects.map((subject) => `- ${subject}`), '')
  if (!grouped.size) lines.push('无', '')
  lines.push('## 新增迁移与语句分类', '')
  for (const migration of analysis.migrations) {
    lines.push(`### ${migration.tag}`, '')
    for (const [i, statement] of migration.statements.entries())
      lines.push(
        `- 语句 ${i + 1}：${statement.category}${statement.contractReason ? `；template-contract: ${statement.contractReason}` : ''}`,
        '```sql',
        statement.sql,
        '```',
      )
    lines.push('')
  }
  if (!analysis.migrations.length) lines.push('无', '')
  lines.push('## 配置、环境变量、密钥与部署绑定', '')
  for (const detail of analysis.details) {
    lines.push(`### ${detail.path} — ${detail.kind}`, '')
    if (detail.added.length) lines.push(`- 新增：${detail.added.join(', ')}`)
    if (detail.removed.length) lines.push(`- 删除：${detail.removed.join(', ')}`)
    if (detail.env?.added.length) lines.push(`- 环境校验新增键：${detail.env.added.join(', ')}`)
    if (detail.env?.removed.length) lines.push(`- 环境校验删除键：${detail.env.removed.join(', ')}`)
    if (detail.lines?.length) lines.push('```diff', ...detail.lines, '```')
    lines.push('')
  }
  if (!analysis.details.length) lines.push('无', '')
  lines.push(
    '## 依赖主版本变化',
    '',
    ...(analysis.dependencies.length ? analysis.dependencies.map((item) => `- ${item}`) : ['无']),
    '',
  )
  return { markdown: lines.join('\n'), range, analysis }
}

export function writeDraft(version, draft, cwd = process.cwd()) {
  const template = readFileSync(join(cwd, 'docs/upgrades/_template.md'), 'utf8')
  let output = template
    .replaceAll('<版本号>', version)
    .replaceAll('<上一版本>', draft.range.previous)
  output = output
    .replace(/^(version:)\s*.*$/m, `$1 ${version}`)
    .replace(/^(previous:)\s*.*$/m, `$1 ${draft.range.previous}`)
    .replace(/^(date:)\s*.*$/m, `$1 ${new Date().toISOString().slice(0, 10)}`)
    .replace(/^(breaking:)\s*.*$/m, `$1 ${draft.analysis.breakingReasons.length > 0}`)
  output += `\n<!-- 以下为自动采集的发版材料；人工整理到固定章节后删除。 -->\n\n${draft.markdown}`
  const path = join(cwd, `docs/upgrades/${version}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, output, { flag: 'wx' })
  return path
}

export function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const [command, ...options] = args
  const { values } = parseArgs({
    args: options,
    options: {
      version: { type: 'string' },
      base: { type: 'string' },
      write: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (command === 'draft') {
    const draft = draftRelease(values.version, cwd)
    if (values.write) {
      writeDraft(values.version, draft, cwd)
      console.log(`Wrote docs/upgrades/${values.version}.md`)
    } else console.log(draft.markdown)
    return 0
  }
  if (command === 'check' || command === 'lint-migrations') {
    const errors =
      command === 'check' ? checkRelease(values.version, cwd) : lintMigrations(values.base, cwd)
    for (const error of errors) console.error(error)
    if (!errors.length) console.log(`${command}: passed`)
    return errors.length ? 1 : 0
  }
  throw new Error(
    'Usage: template-release.mjs draft --version x.y.z [--write] | check --version x.y.z | lint-migrations --base revision',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
