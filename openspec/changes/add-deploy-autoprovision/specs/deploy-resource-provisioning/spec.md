## Purpose

在 Cloudflare 部署前按约定名称解析或创建项目所需的资源，并生成已填好 ID 的部署配置，使衍生项目不必手工替换 wrangler 配置中的资源 ID，且重复执行结果一致。

## ADDED Requirements

### Requirement: 默认只读的资源计划
资源解析命令 SHALL 接受目标环境（如 staging、production），默认只读：列出 web 与 jobs 在该环境用到的每个 KV、R2 桶、队列与 Hyperdrive 绑定，以及各自的期望名称、来源（已固定 / 按名称找到 / 待创建 / 不能自动创建）和找到的 ID。只读模式 MUST NOT 创建、修改或删除任何 Cloudflare 资源，也 MUST NOT 写入部署配置以外的文件。

#### Scenario: 新项目首次查看计划
- **WHEN** 新生成的项目在只有占位 ID 的情况下对 staging 运行只读计划
- **THEN** 输出 KV、R2 桶、各队列为「待创建」，Hyperdrive 为「不能自动创建」，账号中不新增任何资源，命令以非零状态结束并说明还缺什么

#### Scenario: 全部已就绪
- **WHEN** 所有资源都已存在或已固定
- **THEN** 只读计划以零状态结束，并为每个 app 写出部署配置

### Requirement: 已固定的 ID 优先
已提交配置中写有真实 ID（非占位值）的绑定 MUST 原样进入部署配置，不按名称查找，也不创建同名资源。占位值 SHALL 只包括缺少 ID 与生成器使用的占位格式，解析命令与配置检查 MUST 使用同一判定。

#### Scenario: 已有衍生项目
- **WHEN** 衍生项目的 staging 配置已填入真实 KV 与 Hyperdrive ID，运行解析命令
- **THEN** 部署配置中这些 ID 不变，命令不需要列出或创建对应资源的 API 权限

### Requirement: 按约定名称查找与创建
需要解析的资源 SHALL 按约定名称查找，名称由该环境的 Worker 名与绑定名推出，并与现有队列、R2 桶的命名一致。同一环境中 web 与 jobs 共享的绑定（如 `CACHE`、`HYPERDRIVE`）MUST 解析到同一个资源。允许创建的模式下，找不到的资源 SHALL 按约定名称创建，再写入部署配置。

#### Scenario: web 与 jobs 共享 KV
- **WHEN** staging 的 `CACHE` 为占位值，账号中尚无对应 KV
- **THEN** 只创建一个按约定命名的 KV，web 与 jobs 的部署配置使用同一个 ID

#### Scenario: 中断后重跑
- **WHEN** 上一次运行创建了 KV 后，在创建队列时失败，随后再次运行
- **THEN** 第二次运行沿用已创建的 KV 与已存在的队列，只创建仍缺的资源，账号中没有重复资源

### Requirement: 不能自动创建的资源
Hyperdrive 缺失时，解析命令 MUST 失败并给出创建所需的步骤，除非显式开启从受保护环境变量读取连接串的创建开关。连接串 MUST NOT 出现在命令参数、输出或生成的文件中。限流 `namespace_id` MUST NOT 由解析命令分配；命令 SHALL 检查同一项目各环境、各绑定的 `namespace_id` 互不相同。

#### Scenario: Hyperdrive 缺失
- **WHEN** staging 的 `HYPERDRIVE` 为占位值且账号中找不到约定名称的 Hyperdrive，未开启创建开关
- **THEN** 命令失败，提示期望名称与创建方式，日志中没有连接串

#### Scenario: 显式创建 Hyperdrive
- **WHEN** 开启创建开关，并在进程环境中提供 app 账号连接串
- **THEN** 命令按约定名称创建关闭缓存与开启缓存的两个配置，输出与日志中只出现名称和 ID

### Requirement: 名称冲突与权限不足时停止
同一约定名称在账号中对应多个资源时，命令 MUST 失败并列出这些资源的 ID，不自行挑选。API 令牌缺少列出或创建某类资源的权限时，命令 MUST 失败并指出缺少的权限，MUST NOT 跳过该绑定或回退为不绑定。

#### Scenario: 令牌缺少队列权限
- **WHEN** 需要创建队列，但 CI 令牌没有 Queues 编辑权限
- **THEN** 命令失败并说明需要的权限，不部署，也不生成缺少该队列的部署配置

### Requirement: 生产环境默认不创建
对 production 运行时，命令 SHALL 只查找、不创建，除非运行者显式开启生产创建；缺少资源时 MUST 失败并列出缺项。

#### Scenario: 生产缺资源
- **WHEN** production 部署流水线运行解析，账号中缺少约定名称的生产 KV
- **THEN** 解析失败，流水线不迁移也不部署，输出提示用一次性显式创建补齐

#### Scenario: 生产令牌只读
- **WHEN** production 环境的 API 令牌只有读取权限，且生产资源齐全
- **THEN** 解析成功并写出部署配置，过程中不发出任何创建请求

### Requirement: 不修改已提交配置
解析命令 MUST NOT 修改已提交的 `wrangler.jsonc`。部署配置 SHALL 写入版本控制已忽略的位置，内容为已提交配置在目标环境填好 ID 后的结果，其余字段保持不变。

#### Scenario: 本地运行后工作树
- **WHEN** 开发者在本地对 staging 运行解析命令
- **THEN** `git status` 中没有已跟踪文件被修改
