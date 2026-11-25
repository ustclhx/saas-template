# 技术调研：Durable Objects、Cloudflare Agents SDK 与 pi-mono

调研日期 2026-11-23。资料来自 Cloudflare 官方文档与博客、npm 注册表、`cloudflare/agents` 与 `earendil-works/pi` 仓库（含已发布包的源码）。标注「未核实」的条目在实施前需要再确认。

## 0. 结论

1. **底层的 Durable Objects 已经成熟**（GA，含 SQLite 存储、休眠、alarm、30 天按对象时间点恢复）。**上层的 Agents SDK 还没有成熟**：0.x 版本，近 6 个月发了 21 个 minor，大多带破坏性变更，官方没有给出 GA 标识，部分能力标为 Experimental 或 Beta。
2. **费用不是问题**。按对话一个实例估算，每轮的 Durable Object 费用约 $0.00002–0.00024，只有模型 token 费用（约 $0.02/轮）的 0.1%–1.1%。10 万月活、每人每月 50 轮约 $620–1,200/月，大头是流式分块缓冲写入 SQLite 的行数，以及长期累积的存储。
3. **多租户靠「一个对话一个实例 + Worker 入口鉴权 + Postgres 登记表」实现**。实例之间存储隔离，但同类实例可能共用 isolate，模块级全局变量会跨租户可见。
4. **pi-mono 与 Agents SDK 不是二选一**：Agents SDK 已经把 pi 的持久运行时包装成 `PiHarness`，官方甚至建议新 agent 从它起步。但 `pi-durable` 标为 experimental，跨 pi minor 不能回滚，也不支持 AI SDK 的 `useChat`，模型层用的是 pi-ai 而不是我们的 AI SDK 模型注册表。
5. **`AIChatAgent` 是 Cloudflare 官方包，但不自带 agent 循环**：多步工具调用、确认、停止条件都来自 Vercel AI SDK 的 `streamText`，`AIChatAgent` 负责其外的持久化、WebSocket 协议、续流与恢复，与 pi 没有依赖关系。SDK 里的「循环引擎」有三种：AI SDK（`AIChatAgent` 自己写，`Think` 内置）、pi-durable（`PiHarness`）、自己实现（见 §8）。
6. **Durable Object 没有独立于 Worker 的部署形态**：类必须由某个 Worker 导出，可以放在业务 Worker 内，也可以放在单独的 Worker 中，供同账户的其他 Worker 通过 `script_name` 绑定使用。技术上可以多个业务共用一套，但每个业务的鉴权、积分、模型与工具都在各自的库里，共用的只剩一层外壳，耦合与风险大于收益；建议代码经模板插件复用，运行时每个项目各自部署（见 §9）。
7. **建议**：首版仍用 `AIChatAgent`。它是 SDK 里最成熟的一条路，与我们现有的 AI SDK 模型、计费和消息渲染直接兼容。用适配层隔离 SDK，锁定精确版本，不用装饰器（从而不需要 `agents/vite`），计费完全走我们自己的账本。`pi-durable` 作为后续备选，触发条件见 §6。容器 / Sandbox 只在将来需要「执行代码、读写文件」的 agent 时再引入。

---

## 1. 费用

### 1.1 价格（Workers Paid，$5/月起）

| 项目 | 每月包含 | 超出单价 |
|---|---|---|
| 请求（HTTP、RPC 调用、WebSocket 入站消息、alarm） | 100 万 | $0.15 / 百万 |
| 时长（按 128 MB 计） | 40 万 GB-s | $12.50 / 百万 GB-s |
| SQLite 读取行 | 250 亿 | $0.001 / 百万 |
| SQLite 写入行 | 5,000 万 | $1.00 / 百万 |
| SQLite 存储 | 5 GB-月 | $0.20 / GB-月 |

- **WebSocket**：只对入站消息计费，按 20:1 折算成请求（100 条入站消息算 5 个请求）。出站消息和协议 ping 免费，所以服务端推送流式分块不计请求费。
- **休眠**：实例空闲且满足休眠条件后不计时长。进行中的 I/O、`setTimeout`、标准（非休眠）WebSocket 会阻止休眠；Agents SDK 0.22 起 WebSocket 一律使用休眠 API。
- **存储**：删除数据后实例自动清理，不再计存储费；空库约 12 KB 元数据，`deleteAll()` 后即释放。
- **支出上限**：Durable Object 有账户级支出上限，但它不覆盖存储，也不覆盖已建立 WebSocket 上的消息，所以不能当作账单封顶。

来源：<https://developers.cloudflare.com/durable-objects/platform/pricing/>（2026-11-13 更新）、<https://developers.cloudflare.com/workers/platform/pricing/>

### 1.2 每轮的实际写入（读 `@cloudflare/ai-chat` 0.12.3 源码）

`AIChatAgent` 为了支持续流，会把流式分块按每 10 块一段写入 `cf_agents_stream_blocks`，一轮结束时再删除；另外还有流状态行、用户与助手消息、每轮的恢复 fiber 行，以及每 30 秒一次的保活 alarm。合计估算每轮写入 **60–120 行**；下面的模型以 100 行为基准，200 行为高估。索引更新是否额外计写入行，未核实。

### 1.3 费用估算

假设：每轮 2 个计费请求；流式输出期间实例保持活跃 20 秒（高估 30 秒），每轮 2.5 GB-s；每轮写 100 行（高估 200 行）；每轮新增存储 20 KB。

| 场景 | 轮次/月 | 时长费 | 写入行费 | 存储（首月） | **Durable Object 合计/月** | 每轮 |
|---|---|---|---|---|---|---|
| 1 千月活 × 30 轮 | 3 万 | $0 | $0 | $0 | **$0**（在 $5 套餐内） | ≈ $0 |
| 1 万月活 × 50 轮 | 50 万 | $10.6（高 $18.4） | $0（高 $50） | $1 | **约 $12（高约 $70）** | $0.00002–0.00014 |
| 10 万月活 × 50 轮 | 500 万 | $151（高 $229） | $450（高 $950） | $19 | **约 $620（高约 $1,200）** | $0.00012–0.00024 |

**对比 token 费用**：一轮按 3k 输入 + 800 输出、$3/$15 每百万 token 计，约 $0.021，Durable Object 只占 0.1%–1.1%。Worker 本身（每次连接 1 个请求）可以忽略。

**需要控制的两项：**

- **存储累积**：10 万月活规模下，保留 12 个月历史约 1.2 TB，约 $239/月。对策：`maxPersistedMessages` 上限，以及长期不活跃对话的保留期（见 §7 决策 3）。
- **写入行**：主要来自流式缓冲，分块大小写死为 10，没有找到配置项。量级可接受，无需处理。

### 1.4 相关限额

| 项目 | 限额 |
|---|---|
| 实例数 | 不限 |
| 类 | 每账户 500 个 |
| 单实例存储 | 10 GB（Agents 文档写 1 GB，两处冲突，未核实；按 1 GB 设计更保守） |
| 单实例吞吐 | 单线程，软上限 1,000 rps |
| CPU | 每请求 / 每条消息 30 s，可调到 5 min；连接期间墙钟时间不限 |
| 内存 | 每 isolate 128 MB，多个实例共享 |
| 单行大小 | 文档写 8 MB，SDK 源码按 2 MB 处理大消息并压缩 |
| alarm | 每实例 1 个，至少执行一次 |

---

## 2. 成熟度

### 2.1 版本与节奏

| 包 | 首发 | 当前 | 近 6 个月 |
|---|---|---|---|
| `agents` | 2025-03（Cloudflare 接手） | 0.34.0 | 21 个 minor，约 8–9 天一个 |
| `@cloudflare/ai-chat` | 2025-12-29 | 0.12.3 | 5 个 minor（0.8–0.12），20 次发布 |

近一年的破坏性变更举例：

- 0.3.0：迁到 AI SDK v6。现在支持 `ai` 6 和 7，与仓库的 `ai` 7、`@ai-sdk/react` 4 兼容。
- 0.3.2：chat 部分拆成 `@cloudflare/ai-chat`，旧导入加载即报错。
- 0.22：每一轮强制在恢复 fiber 中运行，`chatRecovery: false` 不再允许。
- 0.23–0.24：任务队列表重构，`maxRecoveryWork` 改了单位与默认值，且不会自动换算显式配置。
- 0.27：channels 移到 experimental。
- 0.30 和 0.33：pi 存储迁移单向，不可回滚。
- 0.34：请求错误不再暴露给客户端，新增 `onFetchError` 钩子。

### 2.2 官方状态

- **没有 GA 公告。**Project Think 博客（2026-04）称「已有数千个生产 agent」，但 Think 本身是 experimental。
- **按 0.34 自带文档的标注：**

  | 状态 | 能力 |
  |---|---|
  | Stable | Lifecycle、WebSockets、State、Schedules、MCP client、models |
  | Beta | Pi harness |
  | Experimental | Queue、Routing、Browser、Sessions、Streams、Tasks、Think、Codemode 等 |

- **`AIChatAgent` 的位置**：它没有被弃用，仍在积极修复（0.12.3 修了跨标签页和恢复中的竞态），但已经不是官方主推。官方「选择路径」表把它定位为「聊天界面自己掌握循环与流」，正好是我们的场景。它建立在 `Agent` → Lifecycle 之上，不与新模型冲突。

### 2.3 仓库健康度（2026-11-23）

- 约 6k star、78 位贡献者，MIT 许可。
- issue：174 个未关闭（其中 59 个 bug），760 个已关闭。近 90 天关闭的 issue，中位处理时间 1.5 天。
- 与我们相关的未解决问题：

| 范围 | issue |
|---|---|
| 续流 / 恢复 | #2702 长对话恢复被误判超预算；#2703 中途加入的标签页收不到实时分块；#2741 重连后「停止」无效；#2464 中断的回复可能覆盖真实回复 |
| 存储增长 | #2871 超过约 1 万行后压缩失效（高优先级）；`cf_agents_workflows` 表官方说明会无限增长 |
| 构建 | #2727 `agents/vite` 在 pnpm 隔离安装下失败（本仓库就是 pnpm）；#2730/#2731 发布包含非 Latin-1 字符导致模块内存翻倍 |
| 框架 | #789 TanStack Start 路由报错，因无复现被关闭；#1011 框架 loader 钩子需求未解决 |

### 2.4 与计费直接相关的源码事实

- **SDK 不提供 token 用量。**`onChatResponse` 的结果里没有 usage；框架传给 `onChatMessage` 的 `_onFinish` 是空函数。用量只能从我们自己调用 `streamText` 的 `onFinish` / `totalUsage` 拿到。
- **恢复会重新调用模型。**`continueLastTurn()` 用保存的请求体重跑 `onChatMessage`；如果尚未输出任何内容，就整轮重跑。默认最多尝试 10 次，中断重试 5 次。
- **被驱逐时可能丢用量。**实例在流中途被驱逐时，那次调用的 `onFinish` 不会触发，服务商已经收费的 token 也就不会被记录。所以必须先预扣，再按检查点或保守估算结算。
- **工具可能执行两次。**恢复可能重复执行工具，官方建议工具做幂等键，或在 `onChatRecovery` 中返回 `{ continue: false }`。
- **何时需要 `agents/vite`。**只有使用 `@callable()` 装饰器时才需要；`AIChatAgent` + `onChatMessage` 不需要。不用装饰器就同时绕开了 #2727。
- **嵌入现有 Worker 的方式**：从 Worker 的 `main` 导出实例类，在框架处理之前调用 `routeAgentRequest`，官方文档有 Hono 示例。TanStack Start 的自定义 `server.ts` 结构相同，但官方没有专门验证，所以设计里的第 1 组 spike 仍然需要。

---

## 3. 多租户实现

| 方面 | 机制与做法 |
|---|---|
| 实例粒度 | **一个对话一个实例**。不按空间或用户合并：单实例单线程、128 MB 内存与 1,000 rps 软上限会成为热点；跨对话的索引放在 Postgres |
| 存储隔离 | 每个实例有私有 SQLite，只能在实例内部访问 |
| 内存隔离 | 同一类的多个实例可能共用 isolate，**模块级全局变量跨租户可见**。规范要求：租户相关的状态只放实例字段或存储，代码审查与 `security-scan` 加入此项 |
| 命名与枚举 | `routeAgentRequest` 暴露 `/agents/:class/:name`，官方明确写「知道 URL 就能发请求」。因此 Worker 前置处理必须做会话、成员资格与对话归属校验（design 决策 2），实例再比对已记住的归属。实例名用 Postgres 中的对话 UUIDv7，即使被猜到也过不了鉴权 |
| 身份传递 | 前置处理剥离客户端传入的 `x-saas-*` 头再写入可信头；实例只能经本 Worker 访问。`props` 只在实例启动时传入，不能用于逐请求身份 |
| 数据驻留 | 支持 `eu` / `us` / `fedramp` 司法辖区，可按租户在运行时选择，但同名在不同辖区是不同实例，创建后不能迁移，需要在 Postgres 永久记录辖区。辖区不覆盖 Neon。**首版不做**，需要欧盟驻留的衍生项目另起 change |
| 位置提示 | 尽力而为，只在首次 `get()` 时生效，实例创建后不移动。首版不设置，默认就近创建 |
| 删除 | `deleteAll()` 对 SQLite 实例是原子操作（兼容日期 ≥ 2026-02-24 时同时清除 alarm），之后不再计费 |
| 清理时枚举 | REST API 只能按 id 列出实例，不返回名称，所以 **Postgres 中的对话登记表是清理的唯一依据**（design 决策 7 已如此设计） |
| 备份 | 按实例支持 30 天内时间点恢复，只能由实例内代码触发；**没有批量导出 / 备份工具**，与我们现有的 Postgres 备份恢复流程不在一个体系里（见 §7 决策 2） |
| 部署 | 默认 deferred：活跃实例最多继续运行旧代码 300 秒后重置。已休眠的 WebSocket 能跨代码更新保留，但正在进行的 LLM 流会中断，由 SDK 恢复（会重调模型，计费按 §2.4 处理）。灰度部署时每个实例固定在一个版本，代码需前后兼容 |
| 可观测性 | 控制台按类统计，可按实例 id / 名称过滤；GraphQL 有调用、存储、子请求数据集。`wrangler tail` 在 WebSocket 关闭后才显示其日志，排查依靠 Workers Logs 与我们自己的结构化日志 |

---

## 4. pi-mono 是什么

- **仓库**：`badlogic/pi-mono` 现在重定向到 `earendil-works/pi`，MIT 许可，约 12.3 万 star。Mario Zechner 仍是主要贡献者，Armin Ronacher 第二。包已从 `@mariozechner/*` 迁到 `@earendil-works/*`，2026-10-01 发布 1.0，2026-11-20 发布 1.6，约 1–2 周一个 minor。
- **分层：**

| 包 | 作用 | 运行环境 |
|---|---|---|
| `pi-ai` | 多服务商统一 LLM API | 任意 JS |
| `pi-agent-core` | 内存中的 agent 循环：工具调用、事件流、steering / follow-up、工具前后钩子；不负责持久化 | 任意 JS |
| `pi-durable` | 持久运行时：可持久提交、收件箱、崩溃恢复、工具暂停等待外部信号、压缩、子 agent；`pi.usage` 按模型累计 token 与费用（含失败尝试）；存储后端有内存、IndexedDB、Node SQLite、JSONL 和 **Durable Object SQLite**，没有 Postgres 后端 | **Experimental，API 随时变** |
| `pi-coding-agent` | 我们在 raindown 中用的 CLI / SDK：JSONL 会话树、读写编辑与 bash 工具、技能、扩展 | Node ≥ 22.19，依赖文件系统与子进程 |

- **安全**：README 明确写「pi 没有内置权限系统」，建议用 Docker 等隔离。

---

## 5. 与「在 Cloudflare 自部署 pi」的区别

自部署 pi 在 Cloudflare 上有三种形态：

- **A**：Agents SDK 的 `AIChatAgent`（当前设计）。
- **B1**：在 Durable Object 中跑 `pi-durable`，可以直接用，也可以用 Agents SDK 的 `PiHarness` 包装。
- **B2**：在 Cloudflare Containers / Sandbox 中跑完整的 `pi-coding-agent`。

| 维度 | A：`AIChatAgent` | B1：Durable Object + `pi-durable` / `PiHarness` | B2：Container / Sandbox + `pi-coding-agent` |
|---|---|---|---|
| 隔离 | 每对话一个实例（V8 isolate） | 同 A | 每个沙箱一个容器（VM 级，更强、更重） |
| 运行成本 | 约 $0.0001/轮 | 同 A | 基础实例保活 10 分钟约 $0.002，另加背后的 Durable Object、快照 / R2 |
| 冷启动 | 毫秒级 | 毫秒级 | 中位 0.65 s，p99 1.1 s，另加恢复工作区 |
| 恢复 | 续流 + 自动续跑（会重调模型） | pi 自己的提交、收件箱与恢复，模型更完整 | 容器丢失则本轮失败，上次快照之后的文件丢失 |
| 推流到浏览器 | `useAgentChat`，与 AI SDK `useChat` 消息格式一致，**可复用现有消息部件渲染** | 自己把 `session.watch()` 转成 WebSocket 消息与 UI 格式，不支持 `useChat` | 自己经 Durable Object 代理 pi 的 RPC / JSON 输出 |
| 模型层 | **AI SDK，直接复用 `packages/ai` 的模型注册表、服务商、AI Gateway 与定价** | pi-ai 的模型注册表，需要再对接一次我们的模型管理与定价 | 同 B1 |
| 计费钩子 | 自己的 `streamText` `onFinish` / `onStepFinish`；中途被驱逐会丢用量，靠预扣与检查点兜底 | `pi.usage` 含失败尝试，工具前钩子可做预算检查，计费数据更完整 | 自己解析会话事件 |
| 工具安全 | 进程内业务工具，没有 bash | 同 A；另可用 QuickJS 代码模式 | 有 bash，必须自行锁定出网、凭据与挂载 |
| 会话存储 | 实例 SQLite | 实例 SQLite（`pi_` 表），也可自写存储后端 | 容器磁盘 JSONL，需要另行持久化 |
| 成熟度 | 0.x 周更；`AIChatAgent` 是 SDK 中最成熟的一条 | **experimental**：跨 pi minor 不能回滚，每个 `agents` 版本只支持一个 pi minor | 容器 / Sandbox 已 GA（2026-04）；pi CLI 作为编程 agent 成熟，但不是为多租户服务设计 |
| 锁定 | 高（Durable Objects + SDK） | 中（直接用 `pi-durable` 时，Cloudflare 相关只有存储与唤醒约 50 行胶水） | 低（Docker 镜像） |
| 移植到 selfhost / Node | 差 | **好**：工具、扩展和会话在 Node 上可用 SQLite / JSONL 运行 | 好 |
| 适用 | 带业务工具的聊天 agent（当前需求） | 同左，并且将来要支持 selfhost 或更强的持久任务模型 | 需要执行代码、读写文件的 agent |

和 raindown 里的 pi 的关系：raindown 是在本机或服务器上以 CLI 形态（B2 的思路）把 pi 当执行器，面向我们自己、单租户、允许 bash。模板里的 agent 面向终端用户、多租户、按积分计费，不应该给 bash，所以 B2 不适合首版。

---

## 6. 建议

**首版采用 A（`AIChatAgent`），并做以下加固：**

1. **只用稳定面。**锁定精确版本：`agents` 0.34.0、`@cloudflare/ai-chat` 0.12.3。SDK 只出现在插件的 worker 适配层。每次升级都阅读 CHANGELOG，并做一次「流式进行中部署」的回归测试；按 SDK 存储迁移不可回滚来规划升级。
2. **不用装饰器**，因此不引入 `agents/vite`，规避 pnpm 下的 #2727。
3. **计费只信自己的账本。**每轮先预扣；每一步用 `onStepFinish` 写检查点；被驱逐丢失的用量按检查点和已输出字符做保守估算（与现有文本对话的 Q7 规则一致）。`chatRecovery` 写成类字段，`maxInterruptedAttempts` 调小（建议 2）。`shouldKeepRecovering` 按 `recoveryRootRequestId` 读取本轮已扣积分，超出预扣封顶就停止恢复。
4. **工具幂等。**有副作用的工具必须以「轮次 id + 工具调用 id」为幂等键，例如媒体任务提交时先查重。恢复时如果工具已执行，就返回已有结果。
5. **控制存储。**设置 `maxPersistedMessages`；可选配置对话保留期（见 §7 决策 3）；不使用 SDK 的 workflows 表，长任务继续走我们自己 jobs 中的 Workflow。
6. **多租户规范写进文档与安全扫描。**内容包括：不在模块级保存租户状态、前置处理鉴权、剥离身份头、以 Postgres 登记表驱动清理。

**改用 B1（`pi-durable`）的触发条件，满足任一项即重新评估：**

- 需要 selfhost / Node 也支持 agent；
- `pi-durable` 去掉 experimental 标记，并能跨 minor 回滚；
- `AIChatAgent` 被官方弃用；
- 需要子 agent、外部信号暂停等更复杂的持久任务。

工具契约放在 `packages/ai`，与 SDK 无关，所以切换时工具实现可以保留。

**B2（容器）只用于将来「代码执行 / 文件处理」类 agent。**届时 agent 循环仍在 Durable Object 中，只把执行环境放进 Sandbox（每租户一个，lite / basic 实例，`sleepAfter`，禁止出网），另起 change。

---

## 7. 需要使用者决定的事项

> 已决定（2026-11-24）：1 首版 `AIChatAgent`，pi-durable 备选；2 暂不备份到 PG，以后需要再做；3 保留期做成配置项、默认关闭；4 放在 web Worker。已写入 `design.md` 决策 3、4、6、7、10–12 与 `tasks.md`。

1. **路线**：采用 §6 的建议，即首版 `AIChatAgent`、`pi-durable` 作为备选，还是首版直接用 `PiHarness`？
   - 直接用 `PiHarness` 的代价：自己写聊天协议与 UI 适配、对接 pi-ai 模型层，并接受 experimental 和不可回滚。
2. **消息内容的备份**：
   - 当前设计中，消息正文只在 Durable Object 里，不进入现有的 Postgres 备份恢复体系；单个实例可以 30 天内时间点恢复，但没有批量导出。
   - 可选做法：每轮结束时把消息镜像写入 Postgres（或 R2）一份，代价是双写，每轮多一次数据库写入。
   - 建议：首版不镜像，在文档中写明 agent 对话内容不在数据库备份范围内；衍生项目需要时再加。
3. **对话保留期**：是否默认提供「N 天无活动的 agent 对话自动删除」？
   - 建议：配置项默认关闭；清理由现有清理 Cron 顺带执行，不新增定时任务。

4. **部署形态**：Durable Object 放在 web Worker 内（§9 方案一，建议），还是单独建一个 agents Worker（方案三）？多个业务共用一套运行时不建议（§9.3）。


---

## 8. `AIChatAgent` 详解

### 8.1 出处与定位

- 包名 `@cloudflare/ai-chat`，作者 Cloudflare Inc.，MIT 许可，源码在官方仓库 `cloudflare/agents` 的 `packages/ai-chat`。它是 **Cloudflare 官方 SDK**，2025-12 从 `agents` 主包拆出单独发布。
- README 原话：「Built on Cloudflare Durable Objects and the AI SDK」。依赖只有 `nanoid`；peer 依赖为 `agents`、`ai`（Vercel AI SDK 6/7）、`@ai-sdk/react`、`react`。**不依赖任何 pi 包**；pi 只出现在 `agents/harness/pi`，并且是可选 peer 依赖。
- 类继承关系：`AIChatAgent` → `Agent` → Lifecycle（官方标为 Stable 的部分）→ Durable Object。

### 8.2 循环由谁提供

`AIChatAgent` **自己不调用模型，也不实现工具循环**。开发者在 `onChatMessage()` 中自己调用 AI SDK 的 `streamText`，循环能力全部来自 AI SDK：

```ts
export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(_onFinish, options) {
    const result = streamText({
      model,                                     // 任意 AI SDK provider，可复用 packages/ai 的模型注册表
      messages: await convertToModelMessages(this.messages),
      tools: { getWeather: tool({ inputSchema, execute, needsApproval }) },
      stopWhen: isStepCount(5),                  // 多步：模型调工具 → 拿结果 → 再推理，最多 5 步
      abortSignal: options?.abortSignal,         // 用户点「停止」时取消
      onStepFinish, onFinish,                    // 用量从这里取（§2.4）
    })
    return result.toUIMessageStreamResponse()
  }
}
```

能力的出处分成两部分：

| 来自 AI SDK（`streamText`） | 来自 `AIChatAgent` |
|---|---|
| 多步工具调用循环、停止条件、并行工具调用 | 消息自动写入实例 SQLite、条数上限（`maxPersistedMessages`） |
| 工具输入 schema 校验、工具结果回填 | WebSocket 协议，实时推给该对话的所有连接（多标签页同步） |
| `needsApproval`（工具执行前要求批准）的语义 | 确认往返：暂停 → 客户端 `addToolApprovalResponse` → 继续本轮 |
| 服务商适配、流式输出、用量统计 | 客户端工具：没有 `execute` 的工具交给浏览器执行，结果回来后自动续轮 |
| `pruneMessages()` 控制送给模型的上下文 | 断线续流（分块缓冲在 SQLite）、实例被驱逐后的持久恢复 |
| | 并发策略 `messageConcurrency`：queue / latest / merge / drop / debounce |
| | `saveMessages()`：服务端主动发起一轮（定时、Webhook、异步任务回写） |
| | 把另一个 `AIChatAgent` 当工具调用（`agentTool()`，子 agent 在自己的实例里运行） |
| | 经 `Agent` 基类连接 MCP 服务器、调度任务（Stable） |

所以，「简单 tool use」这类 agent 能力它**都具备**：多步工具调用、人工确认、浏览器端工具、子 agent 作为工具、MCP 工具。这些能力的循环逻辑是 AI SDK 的，`AIChatAgent` 负责把它们放进一个持久、可续、可恢复的会话里。

**不提供**的部分：

- 上下文压缩与长期记忆（Think 有）；
- 技能（skills）；
- 费用核算（只能自己从 `streamText` 回调取用量）；
- 复杂的持久任务编排（暂停数天等待外部信号、收件箱、子 agent 分叉，这些 pi-durable 有）。

### 8.3 Agents SDK 里的四种 agent 实现方式

| 方式 | 循环引擎 | 状态 | 聊天协议 / 前端 | 适合 |
|---|---|---|---|---|
| `AIChatAgent` | **AI SDK `streamText`**，开发者写在 `onChatMessage` 里 | 包 0.x，但建立在 Stable 能力上，最成熟 | 自带，`useAgentChat`（与 AI SDK `useChat` 同一消息格式） | 聊天界面自己掌握循环与流（官方选型表原话） |
| `Think` / `ThinkHarness` | AI SDK，循环与默认能力内置（压缩、记忆、工作区等） | **Experimental** | 与 `AIChatAgent` 同一 WebSocket 协议，前端可迁移 | 「所有默认能力都内置」的聊天 / 推理 agent |
| `PiHarness` | **pi-durable**（pi 自己的循环、收件箱、重试、恢复） | pi-durable **Experimental**，跨 pi minor 不可回滚 | 不提供，需要自己把 `session.watch()` 转成前端消息 | 官方选型表首推的「带工具与恢复的模型循环」 |
| Sessions + Streams + Tasks | 自己写 | Experimental | 自己写 | 完全自定义 |

结论：**pi 只是其中一个可选引擎**，不是 Agents SDK 的底层。我们选 `AIChatAgent` 时，循环用的是我们已经在用的 AI SDK。

### 8.4 与现有文本对话的对应

| 现有文本对话 | agent（`AIChatAgent`） |
|---|---|
| `POST /api/ai/chat` + SSE，`useChat` | WebSocket `/agents/...`，`useAgentChat`（消息格式相同，现有 `message-parts` 与 `registerToolRenderer` 可复用） |
| 消息存 Postgres `ai_message` | 消息存实例 SQLite；Postgres 只存对话列表和轮次记录 |
| 停止：`/api/ai/chat/:id/stop` | 客户端 `stop()` 发送取消帧，经 `abortSignal` 传进 `streamText` |
| 断线：流中断，按检查点结算 | 断线续流；实例被驱逐时自动恢复，恢复会重新调用模型（§2.4） |
| 单次 `streamText`，没有工具 | `streamText` + tools + `stopWhen`，即多步循环 |
| 预扣、结算、清理器 | 同一套规则，`refType: 'agent_turn'`（design 决策 3） |

---

## 9. Durable Object 的部署形态

### 9.1 基本事实

- **没有脱离 Worker 的独立 Durable Object 服务。**每个 Durable Object 类都必须由某个 Worker 脚本导出，在该 Worker 的 wrangler 中声明 SQLite 类（`new_sqlite_classes` 迁移或 `exports`），随该 Worker 一起部署。
- **其他 Worker 可以绑定它。**在自己的 wrangler 中写 `durable_objects.bindings[{ name, class_name, script_name: "<定义它的 Worker>" }]`，然后用 `stub.fetch()`（包括转发 WebSocket 升级请求）或 RPC 调用实例。Agents SDK 文档明确支持：routing 文档写到 namespace「可以是另一个 Worker 通过 `script_name` 导出的类，从而独立部署与扩缩」；configuration 文档用 `script_name` 区分 staging 与 production 的命名空间。
- **本仓库已有先例**：web 的 `AI_MEDIA_WORKFLOW` 就是用 `script_name: "jobs"`（各环境为 `jobs-staging` / `jobs-production`）绑定 jobs Worker 里的 Workflow 类。
- **范围**：绑定在同一个 Cloudflare 账户内解析，跨账户只能走公网 HTTP。这一点来自绑定机制，未在文档中找到逐字说明。每个环境的命名空间相互独立，staging 与 production 不共享实例。
- **实例运行位置**：同一份代码，但 Durable Object 实例与处理普通请求的 Worker 不在同一个执行上下文里。实例按名称全球唯一，运行在创建时选定的位置；Worker 请求在离用户最近的节点处理，再路由到实例。
- **部署影响**：默认 deferred 模式下，活跃实例最多继续用旧代码运行 300 秒后重置；已休眠的 WebSocket 能跨更新保留。一般 20–60 秒的一轮会在旧代码上跑完，超长的轮次会被中断并由 SDK 恢复。来源：<https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/>
- **目前的发布方式**：staging 每次合并都会同时部署 jobs 与 web。所以只把 Durable Object 挪到 jobs，并不能减少它被重新部署的次数。

### 9.2 单个项目内的三种放法

| | 方案一：放在 web Worker（当前设计） | 方案二：放在 jobs Worker | 方案三：新建 agents Worker |
|---|---|---|---|
| 入口与鉴权 | 前置处理、会话校验与实例在同一个 Worker，链路最短 | 浏览器仍连 web；web 鉴权后 `stub.fetch` 转发到 jobs 的类 | 同方案二，转发到 agents Worker |
| 绑定 | 直接复用 web 的 Hyperdrive、KV 会话、AI、R2、限流 | jobs 已有数据库与积分，但缺 KV 会话与限流，需要补 | 需要单独配置一整套绑定与密钥（LLM、数据库、Sentry） |
| 部署耦合 | 每次 web 部署都触发 deferred 重置 | jobs 同样每次部署 | **可以只在 agents 代码变化时才部署**（需要在 CI 中按产物哈希跳过） |
| 打包 | web 包体积增加（仅启用插件时） | jobs 包体积增加 | 独立包，互不影响 |
| 本地开发 | 现有 dev 命令即可 | 现有 dev 已同时启动 web 与 jobs | 需要再起一个 Worker（Vite 插件的辅助 Worker 或多份 wrangler 配置） |
| CI / 部署脚本 / `check-plugins` | 改动最少 | 中等 | 新增一个 app：构建、部署、健康检查、Sentry、环境检查、生成器、template-sync 都要覆盖 |
| 以后迁移 | 实例类在插件内、绑定由清单声明，迁到方案三只需改导出位置与 wrangler 的 `script_name`；但 Durable Object 数据不能跨脚本迁移，迁移前的对话会留在旧命名空间 | — | — |

**建议首版用方案一。**理由：

- 一轮通常不超过 300 秒，deferred 部署对它影响很小；
- 鉴权与绑定复用最多，改动最少；
- 方案三的主要收益是「代码不变就不重新部署」，但这要等对话量上来、出现了实际的中断问题才值得为它多维护一个 Worker。

**需要提前定下来的一点**：实例数据跟着定义它的脚本走，一旦有了线上对话再换方案，旧对话需要导出重建或者放弃。所以如果预期 agent 会成为核心功能、发布又很频繁，可以首版直接用方案三。

### 9.3 多个业务共用一套 agents Worker？

**技术上可行**：同一账户下，xuanxue、product-res 等各自的 web Worker 都可以用 `script_name` 绑定同一个 agents Worker 的类，按「产品前缀 + 对话 id」命名实例。

**但共用的价值很小**，因为 agent 的每一轮都离不开业务数据：

| agent 每轮需要的东西 | 在哪里 |
|---|---|
| 登录会话、空间成员资格 | 各产品自己的 Better Auth 数据库 |
| 模型注册表、套餐权益、定价快照 | 各产品自己的库 |
| 积分预扣、结算、欠费 | 各产品自己的账本 |
| 业务工具（查资料、生成图片、读文件） | 各产品自己的库、R2、媒体任务 |
| 系统提示词与 agent 定义 | 各产品不同 |

共用 Worker 要么同时持有所有产品的数据库和密钥（耦合、权限过大），要么通过服务绑定回调各产品 Worker 来完成鉴权、预扣、结算和工具执行。后者真正被共用的只剩 `AIChatAgent` 这一层外壳，而这层外壳已经通过模板插件在代码层面复用了。

**共用的额外代价：**

- **发布耦合**：一次 agents 发布同时影响所有产品；SDK 存储迁移不可回滚，一个产品出问题不能单独回退。各产品也没法停在不同的 SDK 版本上。
- **爆炸半径**：一个产品的提示注入、工具缺陷或内存溢出循环，会落在共用的实例与 isolate 上。同类实例共用 isolate 时，模块级全局变量的隔离风险扩大到跨产品。
- **费用归属**：控制台与 GraphQL 只能按类统计。想按产品拆账，就要给每个产品单独建类，而每个类都要在共用 Worker 里加迁移，等于又回到了每个产品一套。
- **与模板模型冲突**：衍生项目是独立仓库，可能由不同所有者部署在不同账户；共用运行时不属于任何一个仓库，template-sync 和生成器都覆盖不到它。
- **数据驻留与删除**：删号、删空间的清理要跨产品协调。

**建议：代码复用走模板插件，运行时每个项目各自部署。**只有出现以下情况时，才考虑共用运行时：

- 要做一个面向多个产品的 agent 平台，比如跨产品统一的记忆和用量中心；
- 需要跨产品的 agent 协作；
- 多个产品确定在同一个账户、由同一团队维护，并且愿意接受统一发布节奏。

届时也应该是「共用循环外壳 + 各产品通过服务绑定提供鉴权、计费和工具」的结构，另起 change 设计。
