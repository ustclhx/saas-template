# i18n Specification

## Purpose

让站点以模板配置的多种语言提供页面、邮件与错误提示，并定义语言的选择、记忆与回退规则。
通过公开页面的语言路由与跨设备保存的用户偏好保持语言体验一致，并在翻译缺失时使用默认语言保障可读性。

## Requirements

### Requirement: 语言路由
默认语言的公开页面 SHALL 使用无前缀地址；其他已配置语言的公开页面 SHALL 使用唯一的小写语言前缀（语言 id 转小写，如 `zh-Hant` → `/zh-hant/…`）。
- 未配置的语言前缀 MUST 返回 404。
- 带默认语言前缀的地址（如 `/en/pricing`）MUST 301 到无前缀地址；大小写不同的前缀写法 MUST 301 到小写地址。
- 公开页面 MUST NOT 因选择语言返回 30x：不按 Accept-Language、IP 或 User-Agent 跳转，也不按 Cookie 或查询参数在同一地址渲染不同语言。
- 公开页面的 `<html lang>` MUST 等于页面内容的实际语言；从右到左书写的语言 SHALL 输出 `dir="rtl"`，其他语言输出 `dir="ltr"`。

#### Scenario: 访问中文定价页
- **WHEN** 访客打开 `/zh/pricing`，且 `zh` 在配置的语言中
- **THEN** 页面以中文显示，`<html lang="zh">`

#### Scenario: 未配置的语言
- **WHEN** 访客打开 `/fr/pricing`，而 `fr` 未配置
- **THEN** 返回 404

#### Scenario: 默认语言没有第二套地址
- **WHEN** 默认语言为 `en`，访客打开 `/en/pricing`
- **THEN** 返回 301，`Location` 为 `/pricing`

#### Scenario: 大小写前缀
- **WHEN** 配置了 `zh-Hant`，访客打开 `/zh-Hant/pricing`
- **THEN** 返回 301，`Location` 为 `/zh-hant/pricing`

#### Scenario: 浏览器语言不影响响应
- **WHEN** 分别以 `Accept-Language: zh-CN` 与 `Accept-Language: en-US` 请求 `/`
- **THEN** 两次响应状态均为 200、都没有 `Location`，正文语言相同

### Requirement: 语言选择与记忆
系统 SHALL 只在浏览器端提示语言：页面水合后，比较 `navigator.language` 与当前页语言；当本页存在该语言的已发布版本时，显示固定定位的提示条。
- 提示条 MUST NOT 出现在服务端或预渲染输出的 HTML 中，MUST NOT 占用版面或引起布局位移。
- 提示条 SHALL 用普通链接指向对应语言的对应页面，可以关闭，关闭后在本浏览器中不再出现。
- 提示与关闭 MUST NOT 产生服务端 `Set-Cookie`。
- 用户在语言切换器中手动切换后，已登录用户的选择 SHALL 保存到账号设置，并在其他设备的应用区生效。
- 语言切换器 SHALL 使用普通链接，且只链接本页真实存在的语言版本。

#### Scenario: 中文浏览器访问英文页
- **WHEN** 浏览器语言为 `zh-CN` 的访客打开英文的 `/pricing`，且 `/zh/pricing` 已发布
- **THEN** 水合后屏幕底部出现提示条，其中的链接指向 `/zh/pricing`；服务端返回的 HTML 中没有该提示

#### Scenario: 对应语言未发布
- **WHEN** 浏览器语言为 `zh-CN` 的访客打开一篇只有英文版本的文章
- **THEN** 不显示语言提示

#### Scenario: 登录用户换设备
- **WHEN** 用户在一台设备上把语言改为中文，然后在另一台设备登录
- **THEN** 应用区以中文显示

### Requirement: 文案回退
某条文案在当前语言中缺失时，系统 SHALL 回退到默认语言显示，MUST NOT 显示文案键名；构建时 SHALL 报告各语言缺失的文案。

#### Scenario: 缺少一条翻译
- **WHEN** 中文文案文件缺少某个按钮的翻译
- **THEN** 页面上该按钮显示默认语言文本，构建日志列出缺失项

### Requirement: 邮件与错误提示多语言
系统发送的邮件 SHALL 使用收件用户设置的语言（未设置时用默认语言）；接口返回的业务错误 SHALL 以错误码表示，由前端按当前语言显示提示。

#### Scenario: 中文用户的验证邮件
- **WHEN** 语言设置为中文的用户请求重置密码
- **THEN** 收到中文的重置密码邮件

### Requirement: 已登录用户首页记住语言
项目开启「首页记住语言」后，已登录、且在语言切换器中主动选择过非当前语言的用户，打开默认语言首页 `/` 时 SHALL 被带到其所选语言的首页。
- 该功能默认关闭。
- 匿名访客与爬虫 MUST NOT 被带走；内页和分享链接 MUST NOT 被带走。
- 所选语言没有已发布首页时 MUST NOT 跳转。

#### Scenario: 选过中文的用户打开首页
- **WHEN** 功能已开启，已登录用户曾在语言切换器中选择中文，之后打开 `/`
- **THEN** 页面转到 `/zh`

#### Scenario: 匿名访客
- **WHEN** 功能已开启，未登录、浏览器语言为中文的访客打开 `/`
- **THEN** 停留在 `/`，只可能看到语言提示条

#### Scenario: 功能关闭
- **WHEN** 项目未开启该功能，已登录用户曾选择中文后打开 `/`
- **THEN** 停留在 `/`
