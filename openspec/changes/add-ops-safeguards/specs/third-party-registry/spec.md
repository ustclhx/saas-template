## ADDED Requirements

### Requirement: 第三方登记表
项目 SHALL 在 `docs/third-party.md` 为每个第三方服务或产品维护一行，包含：我们自动查询的内容、教使用者手动完成的事项、代码与文档位置、官方出处、上次核对日期、验证方式。验证方式 MUST 是「真账号」「文档」「模拟」「未核对」之一；上次核对日期 MUST 为 `YYYY-MM-DD`，未核对时写 `—`；官方出处 MUST 是 https 链接或「待核实」。

#### Scenario: 格式不合法
- **WHEN** 某行的验证方式写成「已测试」或日期写成「上周」
- **THEN** 守卫测试失败

#### Scenario: 不确定的信息
- **WHEN** 回填时无法从仓库证据确认某第三方是否用真账号验证过
- **THEN** 该行验证方式标为「未核对」，不推测

### Requirement: 新增第三方 SDK 必须登记
任何 workspace 的 `package.json` 新增属于受监视第三方 SDK 的依赖时，该依赖 MUST 映射到登记表中的一行，否则 CI SHALL 失败。

#### Scenario: 新增模型 Provider SDK
- **WHEN** 开发者为新的文本模型服务商添加 `@ai-sdk/<provider>` 依赖但没有登记
- **THEN** 守卫测试失败并提示补充登记行

### Requirement: 第三方操作说明的出处与边界
仓库中描述第三方操作的文档 SHALL 在能通过 API 或 CLI 查询状态时提供查询方式而不是手工步骤；新写或修改第三方操作说明时 SHALL 注明官方出处链接与核对日期。真账号中看到的数据（账号 ID、余额、域名配置、部分密钥、截图）MUST NOT 提交到本仓库，只能写入私有证据库并在仓库中引用。

#### Scenario: 记录真账号验收结果
- **WHEN** 开发者用 staging 真账号完成支付验收
- **THEN** 账号 ID 与截图写入私有证据库，仓库文档只记录验收日期、结论与证据引用
