# Spec Delta

## ADDED Requirements

### Requirement: 选择插件
生成器 SHALL 接受插件列表参数（交互模式中询问），把选择写入新项目的 `plugins` 配置与模板基准记录，并只保留所选插件需要的部署绑定与密钥清单项。选择图片或视频 AI 时 MUST 自动包含媒体插件。

#### Scenario: 选择插件生成
- **WHEN** 以 `--plugins agents` 与 `--ai text` 生成 Cloudflare 项目
- **THEN** 新项目 `plugins` 只含 agents，wrangler 中没有媒体 Workflow 绑定，`.template-base.json` 记录插件列表

#### Scenario: selfhost 选择仅 Cloudflare 插件
- **WHEN** 以 `--target selfhost --plugins agents` 运行生成器
- **THEN** 生成器报错退出且不创建目录，提示该插件只支持 Cloudflare
