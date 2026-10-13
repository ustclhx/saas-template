# Spec Delta

## Purpose

定义从模板生成可独立开发和部署的新项目的行为，目标选择、功能配置和配套运维材料须一致，并确保生成过程不会继承源项目的部署凭据、证书、数据或运行状态。

## ADDED Requirements

### Requirement: 显式部署目标与输出路径
create-project SHALL 接受 `--target cloudflare|selfhost`，省略时默认 Cloudflare；输出目录 SHALL 使用 `--output`。旧 `--target <path>` MUST 明确提示迁移，非法目标 MUST 拒绝，现有防覆盖与源树边界保护 MUST 保留。（P5）

#### Scenario: 生成自托管项目
- **WHEN** 使用 `--target selfhost --output <new-directory>` 和合法项目参数
- **THEN** 生成自身 namespace 的镜像发布配置、Compose、部署/初始化/恢复材料及启用功能对应的无真值清单

#### Scenario: 旧路径参数或非法目标
- **WHEN** 使用旧 `--target ../acme` 或不存在的目标名
- **THEN** 不创建项目，明确提示支持的部署目标与 `--output` 用法

#### Scenario: 默认 Cloudflare
- **WHEN** 不传 target
- **THEN** 默认生成 Cloudflare 项目，原有测试、构建和 staging 路径保持可用

### Requirement: 自托管功能裁剪可运行
生成器 SHALL 支持关闭 billing、credits、营销和 i18n，自托管产物 SHALL 仍能构建运行。不启用的模块 MUST 不要求其密钥/seed 或注册对应入口/后台任务；认证、空间、邮件与成功 heartbeat SHALL 仍可用。启用功能的既有业务语义 MUST 保留。（P5）

#### Scenario: 团队工具全关组合
- **WHEN** 创建 selfhost 项目并关闭 billing、credits、营销和 i18n
- **THEN** Node 构建和容器启动通过，可登录进入空间、使用所选单语言应用入口，health 为正确 SHA，不依赖支付或积分 seed

#### Scenario: 生成副本再次创建项目
- **WHEN** 使用已生成的 selfhost 副本作为源创建另一项目
- **THEN** 新品牌、namespace、目标及功能配置正确，前一个项目的配置真值不进入新项目

### Requirement: 自托管运行文件排除
生成项目 MUST 排除源树的 selfhost secret/证书目录、无扩展名密码、私钥、备份、ownership 及运行 release 状态，不读取这些真值来生成模板。无真值 example 和运维脚本 SHALL 保留。

#### Scenario: 已初始化源项目
- **WHEN** 源项目有 `secrets/auth_secret`、数据库密码文件、证书、owner 记录与备份文件
- **THEN** 这些文件及真值均不出现在新项目，`.env.example`、`secrets.example` 与交付脚本仍存在
