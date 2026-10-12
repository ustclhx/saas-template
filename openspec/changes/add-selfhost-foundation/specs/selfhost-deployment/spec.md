# Spec Delta

## Purpose

定义可选自托管目标在普通 Linux Docker Compose 环境中的构建、启动、入口和容器安全行为，提供本地可验证的基础拓扑，同时保障原 Cloudflare 开发与发布路径。

## ADDED Requirements

### Requirement: 可选 Node 服务端目标
web 和 jobs SHALL 提供独立 Node LTS 生产输出与启动入口，支持原生 Node 模块，不添加平台 CPU 时长限制；默认构建仍为 Cloudflare。Node web SHALL 支持 SSR、Server Functions、静态资源、流式响应及数据库不可达时的公开页/预渲染降级。（R1、R5、R6）

#### Scenario: 运行 Node 产物
- **WHEN** 启动 web/jobs 的 Node 生产输出
- **THEN** 服务无需 workerd 运行，web 页面、Server Function 与流式端点可用，jobs 进程报告真实能力状态

#### Scenario: 无数据库构建
- **WHEN** 没有生产凭据且数据库不可达时构建公开页面
- **THEN** 预渲染使用既有降级行为并成功，不读取生产密钥

### Requirement: Compose 顺序启动
官方 SHALL 提供 deploy/selfhost/compose.yaml，含 postgres、缓存、一次性 migrate、web、jobs 和可选代理 profile。Compose SHALL 消费已构建镜像，MUST 不在服务器构建。应用启动 MUST 等待数据库与缓存就绪以及使用 migrator 的迁移成功；迁移支持现有 SQL。（D3）

#### Scenario: 空白环境
- **WHEN** 已填写配置/secret并提供测试或正式镜像引用，在空卷部署目录执行 docker compose up -d
- **THEN** 创建角色与权限、完成迁移后启动应用，不需要服务器编译源码

#### Scenario: 迁移失败
- **WHEN** 一次性迁移容器退出非零
- **THEN** web/jobs 不启动，部署保留失败状态，不通过无限重启迁移掩盖错误

### Requirement: 单一安全 HTTP 入口
自托管 SHALL 只有代理暴露宿主机 80/443，Postgres、缓存、web、jobs MUST 不映射宿主机端口。可选内置代理 SHALL 支持 ACME 与自带证书；配置 profile 后 SHALL 仍可使用普通 docker compose up -d。关闭内置代理时 SHALL 可经外部代理接入。（H1、D5）

#### Scenario: 独立 Compose TLS
- **WHEN** 使用内置代理 profile 与合法域名或自带证书部署
- **THEN** 通过 80/443 访问站点，数据服务只在 Compose 内网可达

#### Scenario: 外部代理
- **WHEN** 关闭内置代理并从专用 ingress 网络接入外部代理
- **THEN** 服务可被代理访问，而数据库/缓存无公网端口

### Requirement: 非 root 与运行边界
全部容器 SHALL 在初始化和正常运行阶段使用非 root 用户，具有健康检查和资源上限。常驻服务 SHALL restart unless-stopped，一次性 migrate SHALL 完成即退出且不自动重启；数据和证书 SHALL 持久化。（H4）

#### Scenario: 空卷及容器重启
- **WHEN** 首次创建数据卷后启动并重启服务
- **THEN** 初始化及服务进程 UID 非零，数据可访问并保留，迁移不循环执行

### Requirement: 结构化滚动日志
服务 SHALL 通过共享日志规范输出脱敏 JSON 到 stdout，Docker 日志 SHALL 配置可调最大大小与保留份数，不记录密钥、验证链接或对话内容。（O1）

#### Scenario: 日志轮转
- **WHEN** 日志达到配置大小
- **THEN** 按保留份数轮转，保留 requestId 关联字段且无凭据值

### Requirement: 可选 Turnstile
系统 SHALL 保留模板 Turnstile 开关；关闭时认证正常可用且不要求其凭据、不渲染或校验 widget，但保留 IP/邮箱防刷。（H5）

#### Scenario: 关闭人机验证
- **WHEN** Turnstile 关闭且未提供其 secret/site key
- **THEN** Node 可启动并接受合法认证请求，超限请求仍被拒绝

### Requirement: 双目标 CI 与发布隔离
Cloudflare SHALL 保持主目标，既有测试、构建和 staging 自动发布不被替换或减少；Node CI SHALL 至少构建 web/jobs 并运行单元测试，不获得 staging 凭据或写入 staging。Node 集成 SHALL 在隔离 PG/缓存验收；依赖真实队列的完整认证 e2e MUST 等 B 后通过才能宣称 A 全部验收完成。（P6）

#### Scenario: PR CI
- **WHEN** A 的实施 PR 运行 CI
- **THEN** 现有 Cloudflare job 与新增 Node job 均验证，Node 不触发 staging 部署

#### Scenario: B 后认证验收
- **WHEN** B 的真实队列已经装配，在空卷本地 Compose 上启用验证邮件与多租户
- **THEN** 注册、通过真实队列收到验证邮件、验证、真实退出再登录及切换空间全部通过；未完成前对应任务保持待办
