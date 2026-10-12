# 2核4GiB预算对齐（建议，未签收）

A正式接口已在 #107 合并；其foundation design §7列出 PostgreSQL、web、jobs、Valkey、代理，但没有可引用的最终CPU/内存cap。已向协调者请求预算。以下是供A/协调者审阅的预算建议，**不是A已确认配置或全服务实测**。

| 服务 | CPU cap | 内存 cap | 验证状态 |
|---|---:|---:|---|
| PostgreSQL17 | 0.9 | 1536MiB | spike与jobs共用2核4GiB容器，仅有共享cgroup实测，尚未独立分配该cap |
| 两个DBOS jobs合计 | 0.5 | 768MiB | 每实例0.25/384MiB建议；每进程RSS/CPU有记录，未在该分割cap下复测 |
| web | 0.4 | 768MiB | A预算及实际负载待验收 |
| Valkey | 0.1 | 256MiB | A预算及实际负载待验收 |
| Caddy/外部代理 | 0.1 | 128MiB | A/D部署选择及实际负载待验收 |
| 宿主/缓存余量 | — | 640MiB | 以上常驻cap合计3456MiB，留640MiB；CPU cap合计2.0，无额外CPU吞吐承诺 |

连接预算采用A设计建议的web业务pool10、每jobs业务pool10、每jobs DBOS native pool5、迁移pool1，合计41；运维连接另留至少5，在PG默认max_connections100内。实际inbox/journal查询应经过A的Database/Drizzle facade，以免混用raw postgres.js codecs额外增加pool或破坏编码。spike为隔离raw/ORM问题用了独立raw与business client，真实连接峰值包含这些实验额外连接，不能直接照抄到生产。

最终选型前需要确认上述cap或提供A的实际cap；1.9在预算尚未对齐时保持未完成。即使预算签收，正式全套服务的OOM/连接/WAL/工作负载验证仍在6.4，不能把本次仅PG+jobs的测量作为web/cache/代理整机已通过。
