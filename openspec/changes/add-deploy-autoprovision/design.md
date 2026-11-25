## Context

动机见 proposal.md。与本设计相关的现状：

- `apps/web/wrangler.jsonc`、`apps/jobs/wrangler.jsonc` 各有顶层（本地开发，Miniflare 模拟）、`env.staging`、`env.production` 三段。
  需要项目自己的资源 ID 的字段有这些：每个环境的 `kv_namespaces[CACHE].id` 与两个 `hyperdrive[].id`（web、jobs 各一份，值相同）；
  web 的 5 个 `ratelimits[].namespace_id`（三个环境各一套）；`vars` 中的 `R2_ACCOUNT_ID`、`AI_GATEWAY_ACCOUNT_ID`。
  R2 桶名、队列名、Worker 名、Workflow 名已经是名称形式，生成器按项目名加前缀改名
  （`scripts/create-project.mjs` 的 `wranglerConfig`，如 `acme-email-staging`），但这些资源仍需事先创建。
- 生成器把 32 位十六进制 ID 换成「24 个 0 加序号」形式的占位值（`postprocessProject`），`PROJECT_SETUP.md` 要求部署前逐项替换。
  限流 `namespace_id` 原样沿用模板的 1001–1015，同一账号下的两个衍生项目会因此共用限流计数。
- 部署流水线（`deploy-staging.yml` / `deploy-production.yml`）：jobs 先 `wrangler deploy --env <env> --dry-run --outdir dist`，
  再 `wrangler deploy dist/index.js --env <env> --no-bundle` 部署；web 由 `@cloudflare/vite-plugin` 在
  `CLOUDFLARE_ENV=<env>` 下构建，输出已展开到单一环境的 `dist/server/wrangler.json`，然后 `wrangler deploy --config dist/server/wrangler.json --no-bundle`。
  两个 app 都直接读取已提交的 `wrangler.jsonc`。
- 代码版本已写入：jobs 部署带 `--var APP_VERSION:<SHA>`，web 构建期常量 `__APP_VERSION__` 取 `APP_VERSION`（本机缺省用 `git rev-parse HEAD`），
  `/api/health` 返回 `version`，流水线用 `scripts/staging/wait-healthy.mjs` 比对完整 SHA。
- 只读检查：`scripts/production/check-wrangler-envs.mjs`（staging / production 绑定集合一致、生产不复用 staging ID、限流 ID 互不相同等）
  与 `scripts/check-plugins.mjs`（插件声明的绑定在各环境存在且种类一致）都在 `pnpm check` 中。
- 模板仓库自身：`env.staging` 是真实在用的资源 ID；`env.production` 的资源已于 2026-10-18 拆除（`docs/07-infrastructure.md` §0），配置里留的是失效 ID。

### Cloudflare / Wrangler 现状（2026-11-25 核对）

标注：**[文档]** 表示在官方页面读到；**[源码]** 表示在本仓库安装的 wrangler 4.146.0 的 `wrangler-dist/cli.js` 中读到，没有文档背书，随版本可能变化；**待核实** 表示没有找到官方出处。

| 主题 | 结论 | 出处 |
| --- | --- | --- |
| 自动创建范围 | 4.45.0 起 `wrangler deploy` 默认对省略 ID 的 KV、R2、D1 绑定自动创建（可用 `--no-x-provision` 关闭）；4.113.0 加入 Queue、Dispatch Namespace 等，并去掉「Experimental」前缀。配置文档现列出 KV、R2、D1、Flagship、AI Search、Agent Memory、Dispatch Namespaces、Queues | [文档] [wrangler CHANGELOG](https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/CHANGELOG.md) 4.45.0 / 4.113.0；[Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)；[changelog 2025-10-24](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/) |
| 是否 GA | CHANGELOG 称已 GA；4.146.0 的隐藏参数 `--x-provision`、`--x-auto-create` 仍标 Experimental，两者默认 `true`，不出现在 `--help` 与命令文档 | [文档] CHANGELOG；[源码]；[cloudflare-docs#32978](https://github.com/cloudflare/cloudflare-docs/issues/32978)（文档仓库 issue） |
| 自动命名 | `<Worker 名>-<绑定名小写，_ 换成 ->`，如 `web-staging-cache`；配置写了 `bucket_name` / `queue` 时用配置的名字 | [源码]；文档只说「以 Worker 名为前缀」[文档] Configuration |
| 重部署如何沿用 | 先读已部署 Worker 上同名同类型的绑定并沿用；**KV 不按名称查找已有命名空间**，Worker 上没有该绑定时就新建，同名已存在时 KV 创建 API 返回 400 | [源码]；[文档] [KV create API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/) |
| ID 写回 | 只在交互终端写回配置；CI 与 Dashboard / Git 部署「不会写回」 | [文档] Configuration；[源码] |
| 权限不足 | 查找时遇到 403 会跳过自动创建并继续部署 | [文档] CHANGELOG（#15472） |
| 多环境 | 每个环境部署为 `<name>-<env>`（本仓库显式写了 `name`），绑定不继承；自动创建的资源按环境分开 | [文档] [Environments](https://developers.cloudflare.com/workers/wrangler/environments/) |
| Queues | 不存在的 producer 队列会被自动创建；只作 consumer 的队列不存在时部署失败并提示 `wrangler queues create`；`dead_letter_queue` 是否检查**待核实** | [源码] |
| Hyperdrive | 不在自动创建范围内，必须有 `id`，创建需要连接串 | [文档] [Hyperdrive get started](https://developers.cloudflare.com/hyperdrive/get-started/) |
| 限流 `namespace_id` | 「由你定义、在 Cloudflare 账号内唯一的整数」，以字符串写入；同一 ID 的绑定共享计数（跨 Worker）；没有创建或列出的 API / 命令 | [文档] [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| Durable Objects | 无单独创建命令，首次部署时创建；各环境的命名空间独立 | [文档] [DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) |
| Workflows | `wrangler deploy` 经 Workflows API 创建或更新 | [文档] CHANGELOG |
| 生成配置 / 重定向 | Wrangler 向上查找 `.wrangler/deploy/config.json`（`{"configPath": ...}`），只对 deploy / dev / versions 生效，目标配置不得含 environments；Vite 插件在构建时按 `CLOUDFLARE_ENV` 展开为单环境，部署时再设 `CLOUDFLARE_ENV` 无效 | [文档] Configuration（Generated Wrangler configuration）；[Vite plugin environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/) |
| 配置内引用环境变量 | 未找到官方支持（待核实，按不支持设计） | — |
| Workers Builds | 部署命令可改为 package.json 脚本；构建变量运行时不可见；Worker 名须与连接的 Worker 一致（Builds 用环境变量覆盖名称）；自动创建会执行但 ID 不写回 | [文档] [Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[troubleshoot](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/) |
| 查找命令的输出 | `kv namespace list` 总是输出 JSON；`d1 list`、`workflows list`、`r2 bucket info` 有 `--json`；`r2 bucket list`、`queues list`、`queues info`、`hyperdrive list` 没有 JSON 输出（4.146.0 `--help`） | [源码] / 本地 `--help` |
| REST 列表过滤 | KV 列表无标题过滤（分页 ≤1000）；R2 有 `name_contains`；Queues 文档只有分页（≤500）；Hyperdrive 只有分页 | [文档] [KV list](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/list/)、[R2 list](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)、[Queues list](https://developers.cloudflare.com/api/resources/queues/methods/list/)、[Hyperdrive list](https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/methods/list/) |
| 令牌权限 | KV 创建需 Workers KV Storage Write；Queues 需 Queues Write 与 Workers Scripts Write 或 Workers Admin；R2（Workers R2 Storage Write）与 Hyperdrive（Hyperdrive Write）的名称**待核实**，实施时在 API 页面确认 | [文档] 各 API 页面 |
| 版本记录 | `wrangler deploy --tag` / `--message`；`version_metadata` 绑定暴露 `id`、`tag`、`timestamp` | [文档] [Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、[Version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/) |

## Goals / Non-Goals

**Goals:**

- 新项目只需提供数据库连接和域名等无法推出的信息，KV、R2 桶、队列由一条可重复执行的命令解析或创建，部署流水线自动调用它。
- 已有衍生项目与模板自身已填好的 ID 不受影响，升级后无需改配置。
- web 与 jobs 共享的资源一定解析到同一个实例；生产默认不创建资源。

**Non-Goals:**

- 不支持 Workers Builds（Cloudflare 在线构建）作为部署入口。模板的发布依赖 GitHub Actions 中的迁移、Sentry、版本门和冒烟，
  Builds 的差异只在文档中说明（见决策 9）。
- 不自动创建 Neon 数据库、自定义域名、Turnstile 站点、AI Gateway 或 secrets。
- 不删除资源。没有「清理」子命令，回收资源仍按 runbook 手工执行。
- selfhost 不使用 Wrangler，不在本 change 范围内。

## Decisions

### 1. 自己解析资源，并关闭 Wrangler 的自动创建

部署前由脚本按名称查找或创建资源，把 ID 写进部署配置；部署命令显式关闭 Wrangler 的自动创建。

不采用「省略 ID，交给 Wrangler 自动创建」，原因有四：

1. Wrangler 按 Worker 名自动命名，web 与 jobs 会各得一个 `*-cache` 命名空间，而本项目要求两者共享同一个 `CACHE`（会话二级存储）。Hyperdrive 也是共享的。
2. KV 不按名称沿用。Worker 首次部署失败或被删除后重建时，会新建空命名空间或因同名报 400（见上表）。
3. 遇到 403 时，Wrangler 跳过自动创建并继续部署，问题要到运行期才暴露，不符合「权限不足要明确失败」。
4. 自动创建覆盖不了 Hyperdrive 和限流，仍然要单独处理。

这个思路也参考了某私有建站引擎的做法：它在部署前按 Wrangler 的默认命名先找 KV，找不到才创建，再生成临时配置交给 `wrangler deploy`，使部署命令可以重复执行。
本设计沿用「先查后建、生成配置」的思路，但用自己的命名约定和共享规则。

部署命令加 `--no-x-provision`（必要时还有 `--no-x-auto-create`）。这两个参数是隐藏的实验参数，任务 2.3 先在 4.146.0 实测确认参数名与效果；
参数被移除时，由于部署配置中已不含省略 ID 的绑定，结果也一样，只是少了一层保险。

### 2. 命名约定：沿用现有前缀与环境后缀

现有队列、桶的名称格式是「项目前缀 + 资源基名 + 环境后缀」（模板为 `email-staging`，衍生项目为 `acme-email-staging`）。
前缀与后缀从该环境的 web Worker 名推出：`acme-web-staging` 去掉 `web` 得到前缀 `acme-`、后缀 `-staging`。约定名称如下：

| 绑定 | 约定名称 | 共享 |
| --- | --- | --- |
| `CACHE`（KV） | `<前缀>cache<后缀>` | web + jobs |
| `HYPERDRIVE` / `HYPERDRIVE_CACHED` | `<前缀>hyperdrive<后缀>` / `<前缀>hyperdrive-cached<后缀>` | web + jobs |
| R2、队列（含死信队列） | 配置中已写的 `bucket_name` / `queue` | 按名称 |
| 插件或项目新增的 KV | `<前缀><绑定名小写，_ 换成 -><后缀>` | 同名绑定共享 |

KV 与 Hyperdrive 按「环境 + 绑定名」合并解析：同一环境里 web 和 jobs 的同名绑定只解析一次，两边写入同一个 ID。
如果两边已固定的 ID 不同，按配置错误失败。解析逻辑遍历配置段，不写死绑定名，插件新增的绑定也能覆盖。

备选方案是在 wrangler 配置中新增名称字段，或另建资源清单文件。前者会让 Wrangler 报未知字段，后者多一个要同步的文件，都没有采用。

### 3. 「已固定」与「占位」的判定

只有缺少 ID，或 ID 匹配生成器的占位格式（`^0{24}[0-9a-f]{8}$`）时才视为占位，其余值一律视为已固定，原样进入部署配置。
判定函数放在共享模块中，`check-wrangler-envs`、生成器与解析命令都使用它。

已固定的 ID 默认不调用 API。加 `--verify` 时才核对这些 ID 在账号中存在，并报告名称与约定不一致的项，只提示，不改动。
这样已有衍生项目升级后，CI 令牌不需要新增任何权限。

### 4. 部署配置的位置与接入方式

解析结果写入 `apps/<app>/wrangler.deploy.json`（已 gitignore）。内容是完整的配置对象，保留 env 结构和全部字段，只填好目标环境的 ID 与可补齐的账号 vars。
文件与原配置在同一目录，`main`、`assets` 等相对路径不变。

- jobs：构建与部署两条命令都加 `--config wrangler.deploy.json`。
- web：`vite.config.ts` 中给 `cloudflare()` 传入 `configPath`。存在 `WRANGLER_DEPLOY_CONFIG` 环境变量时用它，否则用默认值。
  Vite 插件按 `CLOUDFLARE_ENV` 展开后输出 `dist/server/wrangler.json`，部署命令保持不变。

不采用两种备选方案：

- 在 CI 中原地改写 `wrangler.jsonc`。checkout 虽是临时的，但本地运行会弄脏工作树，而且与 spec「不修改已提交配置」冲突。
- 使用 `.wrangler/deploy/config.json` 重定向。它要求目标配置不含 environments，并且 Vite 插件构建时也会写这个文件，两者会冲突。

### 5. 通过 REST API 查找与创建

脚本用 `fetch` 调用 Cloudflare REST API，认证使用 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。原因：

- 4.146.0 的 `r2 bucket list`、`queues list`、`hyperdrive list` 没有 JSON 输出，解析人类可读文本很脆弱。
- 用 Wrangler 创建 KV 时，它会尝试把 ID 写回附近的配置文件（交互终端下）。
- 通过 API 创建 Hyperdrive 时，连接串可以放在请求体中，不进入命令参数。

列表一律翻完所有分页再按名称精确匹配，不依赖未文档化的 `?name=` 过滤。
本地运行同样需要这两个环境变量。缺少时，只读计划会说明需要哪些权限，并提示用 `wrangler login` 的用户另外创建令牌（是否可以复用 Wrangler 的 OAuth 登录态**待核实**，本 change 不依赖）。

### 6. 运行模式

| 模式 | 行为 | 用在 |
| --- | --- | --- |
| `plan`（默认） | 只读：列出解析结果，资源齐全时写部署配置，否则以非零状态退出 | 本地、PR 前自查 |
| `--apply` | 创建缺失的 KV、R2 桶、队列，然后写部署配置 | staging 流水线、首次部署 |
| `--apply --allow-production` | 对 production 也创建资源 | 维护者一次性手动执行 |
| `--create-hyperdrive` | 从 `HYPERDRIVE_APP_URL` 环境变量读取 app 账号连接串，通过 API 创建两个 Hyperdrive（关缓存，以及开缓存 `max_age=60`） | 维护者手动执行 |

创建顺序：KV → R2 → 死信队列 → 其他队列 → Hyperdrive。每创建一项后重新查询确认，任一步失败立即停止，已创建的资源保留，下次运行会沿用。
同名资源多于一个时失败并列出各自 ID（KV 标题在账号内唯一，R2 / 队列名称也唯一，这个分支主要用于 Hyperdrive）。

### 7. 不能自动创建的资源

- **Hyperdrive**：默认只按名称查找，缺失时失败，输出期望名称和两种做法：按 `docs/runbooks/staging-neon.md` §3 在控制台创建，或运行 `--create-hyperdrive`。
  CI 中不开启 `--create-hyperdrive`，以免数据库连接串进入 CI secret 的范围扩大。
- **限流 `namespace_id`**：Cloudflare 没有列出或创建的接口，只能由项目分配。生成器按项目名哈希选出一个号段（例如在 `10000–999999` 内取一段 100 个号），
  在号段内为顶层、staging、production 的各个绑定依次编号。`check-wrangler-envs` 已检查项目内互不相同，解析命令再检查一遍。
  跨项目冲突无法通过 API 检测，只能靠号段降低概率，并在文档中说明（同一账号下项目很多时，可以在 `PROJECT_SETUP.md` 中人工登记号段）。
  模板自身沿用 1001–1015 不变。
- **账号 ID vars**：`R2_ACCOUNT_ID`、`AI_GATEWAY_ACCOUNT_ID` 为空时，用 `CLOUDFLARE_ACCOUNT_ID` 补齐，已有值不覆盖。`AI_GATEWAY_ID`、`TURNSTILE_SITE_KEY`、`routes` 与 `APP_URL` 仍由项目填写，plan 中把空值列为缺项。

### 8. 流水线位置与生产默认不创建

- staging：在 release-policy 检查与 `pnpm install` 之后、迁移之前，运行 `deploy:resources --env staging --apply`。
- production：在 deploy job 的构建之前，运行 `deploy:resources --env production`（只做 plan）。缺资源就失败，由维护者在本地用 `--apply --allow-production` 一次性补齐。

生产默认不创建，是为了防止名称约定或前缀被误改时，生产悄悄换成一组空资源。例如新建一个空 KV 会使全部会话失效。
解析步骤只读取 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，不接触数据库凭据。

### 9. Workers Builds 与本地差异

Workers Builds 不作为支持的入口，`docs/07-infrastructure.md` 中写明以下差异：

- Builds 默认的部署命令直接读取已提交配置，占位 ID 会导致部署失败。
- Builds 会用环境变量覆盖 Worker 名。
- 构建变量在运行时不可见。
- 自动创建的 ID 不会写回配置。

如果以后要支持 Builds，需要把部署命令改为调用本命令的 package.json 脚本，并处理迁移和版本门，届时另开 change。
本地与 CI 的唯一差异是凭据来源；解析逻辑和输出完全相同。

### 10. 代码版本

沿用现有 `APP_VERSION` 机制，不新增。可选：在部署命令上加 `--message <SHA>`，让 Cloudflare 控制台的部署记录也能看到提交号（任务 2.3 一并处理，不改变版本门）。
不引入 `version_metadata` 绑定，因为 `/api/health` 已经承担版本确认。

### 11. 与现有检查、生成器、同步的关系

- `check-wrangler-envs`：改用共享的占位判定。占位 ID 不计入「生产复用 staging ID」检查（现在已靠序号区分，改用判定后更明确）。规则不变。
- `check-plugins`：只检查绑定名和种类，不涉及 ID，不改。解析命令覆盖插件声明的绑定，见决策 2。
- `create-project`：
  - 保留占位 ID；
  - 限流按决策 7 分号段；
  - `R2_ACCOUNT_ID` / `AI_GATEWAY_ACCOUNT_ID` 保持清空，部署时补齐；
  - `PROJECT_SETUP.md` 的资源段改为「自动解析：KV、R2、队列；需要提供：Hyperdrive 连接、域名、Turnstile、Gateway」，并附 plan 命令。
- template-sync：`wrangler.jsonc` 的合并规则不变（项目已填的 ID 按「衍生项目自有配置不被覆盖」保留）。新增的脚本、工作流步骤、`.gitignore` 与 `vite.config.ts` 改动作为模板文件随同步进入。工作流若被项目改过，可能产生合并冲突，升级说明会提示。
- template-release：部署绑定键对比不受影响。本 change 不增删绑定，发布级别按「需要动作」判断（见迁移计划）。
- selfhost：不涉及。
- CI / Turbo：部署工作流直接调用 `pnpm --filter … build`，不经 Turbo 缓存，`turbo.json` 无需改。新增的 `scripts/deploy/*.test.mjs` 加入 `pnpm check` 的 `node --test` 列表。
  PR 中的 CI 不调用 Cloudflare API。改工作流时遵守 `docs/ci.md` §4，deploy 流水线的 concurrency 不变。

## Risks / Trade-offs

- [前缀或 Worker 名被改，约定名称随之改变，staging 悄悄新建一组空资源] → 优先使用已固定 ID；plan 输出每项的来源，`--apply` 新建资源时在流水线摘要中醒目列出；生产默认不创建。
- [两个项目在同一账号中前缀相同，约定名称冲突，误用对方资源] → 生成器已经用项目名做前缀。plan 对「按名称找到但当前 Worker 尚未绑定」的资源给出提示；这种情况无法自动判定归属，在文档中说明不要让两个项目用同名前缀。
- [CI 令牌权限从部署扩大到创建资源] → staging 和 production 用同一个令牌时，生产 job 理论上也能创建资源，已拍板按环境拆分：production 令牌只读，需要创建时由维护者用本地令牌执行（使用者 2026-11-25 确认）。
- [Wrangler 的隐藏参数或自动创建行为在升级后改变] → 部署配置中不再有省略 ID 的绑定，即使参数失效，Wrangler 也没有可以自动创建的对象。任务 2.3 在当前版本实测并记录。
- [创建了一半失败] → 每一步都能重复执行，下次运行沿用已建资源；不提供自动删除，避免误删。
- [Hyperdrive 连接串泄漏] → 只从环境变量读取，放进 API 请求体，不打印。错误输出只保留状态码与 Cloudflare 错误码。测试中断言输出不含连接串。
- [模板 `env.production` 留着失效 ID] → 失效 ID 会被视为已固定，在 plan 和 `--verify` 中报「不存在」。已拍板改为占位值（使用者 2026-11-25 确认，任务 1.5）。

## Migration Plan

1. 按 tasks 顺序合并，先合解析命令，再合流水线接入。模板 staging 的 ID 已固定，接入后 staging 发布行为不变，只多一步不调用 API 的解析。
2. 升级说明（下一个模板版本）：
   - 已有衍生项目无需改 `wrangler.jsonc`。**不要**删除已填写的 ID：删除后会按约定名称新建空资源。
   - 合并工作流改动：若项目自己改过部署工作流，手工加入解析步骤与 `--config`。
   - 新项目或要采用自动解析的环境：给 CI 令牌加上 KV / R2 / Queues 写权限和 Hyperdrive 读权限，先运行 plan，再在 staging 流水线中 apply。
   - 是否 `breaking: true`：已有项目不需要改配置，但部署工作流的接入需要合并，按 `docs/upgrades/README.md` 的规则由协调者在发版时判定（倾向不标记 breaking）。
3. 回滚：
   - 在部署工作流中删除解析步骤和 `--config` 参数，即回到直接读 `wrangler.jsonc`。已固定 ID 的项目不受影响。
   - 依赖自动解析的新项目，需要把 plan 输出的 ID 填回 `wrangler.jsonc`；plan 会打印可直接粘贴的 ID 清单。
   - 已创建的资源不删除。

## 已拍板事项（使用者 2026-11-25 确认）

以下 6 项全部按推荐方案执行（使用者 2026-11-25 确认）：

1. **生产不允许 CI 自动创建资源**：production 流水线只做 plan，缺资源即失败；维护者在本地用 `--apply --allow-production` 一次性补齐。
2. **Hyperdrive 支持脚本创建**：提供 `--create-hyperdrive`，只在本地手动使用，连接串经 `HYPERDRIVE_APP_URL` 环境变量传入；CI 不启用。
3. **CI 令牌按环境拆分权限**：staging environment 的 `CLOUDFLARE_API_TOKEN` 增加 KV / R2 / Queues 写权限与 Hyperdrive 读权限；production environment 的令牌只授予读取权限。
4. **模板自身 `env.production` 的失效 ID 改为占位值**：web 与 jobs 的 KV、Hyperdrive ID 改为生成器占位格式，由任务 1.5 执行。
5. **限流号段**：按项目名哈希映射到 `10000–999999` 内的 100 号段；模板保持 1001–1015。
6. **命令名称**：`pnpm deploy:resources --env <env> [--apply] [--verify] [--allow-production] [--create-hyperdrive]`，脚本为 `scripts/deploy/resources.mjs`。

## Open Questions

- `dead_letter_queue` 指向的队列不存在时，Wrangler 是否报错（待核实）。本设计无论如何都先创建死信队列，结论不影响方案。
- R2 与 Hyperdrive 创建所需的令牌权限名称（待核实）。实施时在 API 页面确认后写入文档，不影响方案。
- 能否复用 `wrangler login` 的 OAuth 登录态调用 REST API（待核实）。本设计不依赖它。
