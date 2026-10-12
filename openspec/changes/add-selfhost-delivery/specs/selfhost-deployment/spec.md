# Spec Delta

## Purpose

定义普通 Linux 单机自托管的镜像交付与运维行为，使同一版本能够通过 plain Docker Compose 或可选运维层发布、核验及恢复，并保留既有 Cloudflare 主目标与入口安全约束。

## ADDED Requirements

### Requirement: 多架构不可变镜像交付
CI SHALL 为 web、jobs、migrate 及官方 Compose 所需配套服务发布 linux/amd64 和 linux/arm64 镜像，默认 GHCR 且允许配置其他 OCI 仓库。镜像 SHALL 使用源码完整 git SHA 标签，版本内镜像与部署材料 SHALL 一致，正式 SHA 标签 MUST NOT 覆写。服务器 MUST 只拉取镜像，不构建源码。（P1）

#### Scenario: 两种架构发布同一版本
- **WHEN** 受信提交通过发布验证
- **THEN** 两架构均可拉取并运行同 SHA 的完整镜像集合，web/jobs 的版本与该提交一致，部署材料可追溯到同一 SHA

#### Scenario: 部分镜像构建失败
- **WHEN** 任一必需服务或架构构建/验证失败
- **THEN** 发布流程失败，不将不完整的版本声明为可部署 release，不改变上一成功版本

### Requirement: 迁移受控的 Compose 发布
交付 SHALL 提供 SSH 部署脚本或工作流，使用 `docker compose pull && docker compose up -d` 更新显式目标版本。同一部署 SHALL 串行发布，新应用 MUST 在目标迁移成功且旧 jobs 已安全退出后启动；迁移失败 MUST 阻止目标应用启动并报告失败，数据卷 MUST 保留。（P2）

#### Scenario: 已有版本升级
- **WHEN** 操作者发布新 SHA
- **THEN** 拉取预构建镜像，停止并确认旧应用退出，重新执行目标迁移，成功后启动应用；服务器无需编译或安装项目依赖

#### Scenario: 目标迁移失败
- **WHEN** 迁移非零退出
- **THEN** 新应用不启动，流程非零退出并保留数据库与失败诊断，不循环迁移以掩盖错误

### Requirement: 发布版本检查与可操作回滚
部署 SHALL 限时检查公开 `/api/health` 的成功状态、完整 SHA 和 Node 依赖 readiness，并核对 jobs 版本。失败 SHALL 非零退出、报告脱敏版本差异和上一成功版本的回滚命令。回滚 MUST 保留数据，只在代码/schema/持久任务兼容时执行；不兼容 SHALL 指向匹配备份恢复，不自动降级数据库。（P3）

#### Scenario: 旧版本或依赖故障
- **WHEN** health 返回旧 SHA、503、任务版本不同或在期限内未就绪
- **THEN** 部署失败，成功版本记录仍指向前版本，并输出可执行的回滚入口与兼容性条件

#### Scenario: 兼容版本回滚
- **WHEN** 操作者选择已记录且与数据库和任务兼容的上一版本
- **THEN** 拉取对应版本并重新检查 health/任务版本，不删除卷或执行破坏性 down migration

### Requirement: 同一 Compose 的可选运维层
plain Compose SHALL 为完整官方交付。Dokploy SHALL 可导入同一 Compose，关闭内置代理并使用自身 Traefik；它 MUST NOT 成为运行依赖。外部代理或 cloudflared SHALL 只接入专用入口网络，数据服务 MUST 不因此暴露宿主端口或接入代理网络。

#### Scenario: Dokploy 导入
- **WHEN** 在已授权且资源充足的环境使用 Dokploy
- **THEN** 同一 Compose 经配置只将 web 内部端口交给 Traefik，保留迁移 gate、secret 隔离和受限可信代理配置

#### Scenario: 使用现有代理
- **WHEN** 关闭 Caddy 并接入现有代理或隧道
- **THEN** 应用可通过内部入口访问，不新占用已有公网端口，PG/缓存/jobs 无新增外部端口

### Requirement: 空白服务器单命令初始化
交付 SHALL 为受支持的全新 Ubuntu/Debian 提供单命令初始化，安装 Docker Engine/Compose v2、启用开机启动、配置仅 22/80/443 入站并生成无真值 `.env` 骨架。重复执行 MUST 保留已有配置/数据；检测到生产服务或端口/资源冲突 MUST 停止自动初始化并给出明确原因。（P4）

#### Scenario: 全新虚拟机初始化
- **WHEN** 操作者在支持的空白 VM 上运行入口
- **THEN** Docker/Compose 可用、SSH 连通、实际外部入站仅为允许端口，生成骨架并指出 secret/TLS 后续配置

#### Scenario: 已用生产服务器
- **WHEN** 主机已有容器、冲突规则或资源不足
- **THEN** 初始化非零退出，不覆盖配置、不清空防火墙、不安装或接管 Dokploy

### Requirement: 主机重启后版本与持久状态恢复
主机重启后全部常驻服务 SHALL 自动恢复，已有数据及未完成任务状态 SHALL 保留，公开 health SHALL 在限定等待后返回成功与目标完整 SHA。恢复 MUST 遵守可信执行者退出和同版本任务恢复约束，一次性成功迁移 MUST 不循环执行。（§6.8）

#### Scenario: 服务器实际重启
- **WHEN** 已成功部署的测试服务器按获准窗口重启
- **THEN** 无手工修补即可恢复全部常驻服务，health 与 jobs 为目标 SHA，持久任务按既定契约恢复且无重复业务结果

#### Scenario: 尚无主机决策或生命周期签收
- **WHEN** 用户未决定目标主机/入口/运维方式，或容器及宿主重启退出证据未签收
- **THEN** 对应服务器/恢复验收保持 BLOCKED，不连接现有 ECS，不以本地进程测试宣称服务器验收完成
