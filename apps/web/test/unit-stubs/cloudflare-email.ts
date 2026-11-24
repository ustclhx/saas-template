// 单元测试（Node 环境）中 `cloudflare:email` 的替身：agents SDK 在模块顶层导入，单元测试不发送邮件。
export class EmailMessage {}
