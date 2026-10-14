# D 1.4 第二次正式发布完整 bundle 验收（2026-10-14）

发布来源：[run 38588820873](https://github.com/ustclhx/saas-template/actions/runs/38588820873)，
完整 SHA `081305013b022f457c561eecf5828b1959e13908`，namespace `ghcr.io/ustclhx/saas-template`。
`publish.json` 记录成功结论与两架构 smoke；`image-set.json` 是成功 artifact 的语义等价副本，
仅经 Biome 排版。本任务未触发 selfhost-publish、未覆写任何正式 SHA。

`bundle.json` 保存从该 SHA Git 对象重新生成的正式 manifest、八服务 digest、完整白名单
与发布压缩 artifact SHA256。新生成 manifest 与发布 artifact 一致；包内原版 verify 通过。
24 项运行材料包含 restore/drill/自包含宿主恢复器、replica Compose 与三份附加 env 示例，
共 27 个文件有 checksum，加上 release.json 共 28 文件。运行材料取自指定 Git 对象，
只把镜像占位符替换为发布 digest；不读取工作树 dotenv/secret/证书/ownership/数据，
没有业务源码、Dockerfile 或服务器构建依赖，正式 bundle 的 fixture=false、兼容回滚声明为空。

`compose.json` 记录干净目录只用 bundle 内 verifier/example/images.env 的基础 config，
以及 backup、object-storage、replica、组合和外部代理 override config。全部 image-only，
所有八服务的引用固定到同 SHA 集合（object-storage-init 复用 migrate digest）；
这些配置验证不读取 secret 内容，也不宣称实际运行备份/对象存储/副本。

可重复的本地构建与校验：

```sh
gh run download 38588820873 --repo ustclhx/saas-template \
  -n selfhost-image-set-081305013b022f457c561eecf5828b1959e13908 -D /tmp/downloaded-image-set
python3 deploy/selfhost/release/bundle.py build --source . \
  --sha 081305013b022f457c561eecf5828b1959e13908 \
  --image-set /tmp/downloaded-image-set/image-set.json --output /tmp/full-release-bundle
python3 /tmp/full-release-bundle/release/bundle.py verify /tmp/full-release-bundle \
  --sha 081305013b022f457c561eecf5828b1959e13908
python3 /tmp/full-release-bundle/release/bundle.py compose-config /tmp/full-release-bundle \
  --sha 081305013b022f457c561eecf5828b1959e13908
```

输出目录须全新。也可直接下载该 run 的同名 `selfhost-release-<完整 SHA>` 压缩 artifact。
checksum 证明传输完整性，信任仍来自成功发布 run 与受信 Git 来源。

根检查见 `root-checks.json`；bundle 7 项既有单测通过。本次仅修改只读验收 workflow 的
固定发布来源与完整材料 gate，并更新交付状态文档；正式运行材料和镜像保持已发布内容。

范围限制：B/D 1.5 尚未签收，2.1/2.3 保持未勾选；未完成任务重放、宿主 reboot、
异机退出、完整备份/PITR、实际对象存储/副本、SSH/真实服务器均不作为本次验收结论。
副本配置的已发布文档另有命名不一致：OPERATIONS.md/secrets.example 使用
`backup_replica_s3_*`，compose.replica.yaml 实际使用 `replica_s3_*`；按实际 Compose
配置提供文件，此处只记录，不混入异 SHA 修复。第 7 组保持 BLOCKED；未连接真实服务器，
未部署共享 CF staging，不代勾 A/B/C，不归档 change。
