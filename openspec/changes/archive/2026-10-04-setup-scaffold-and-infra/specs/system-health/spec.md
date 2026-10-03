# Spec Delta

## Purpose

提供可被外部探活与部署冒烟测试使用的健康检查，反映 Web Worker、数据库连通性与后台 Worker 的可用状态。

## ADDED Requirements

### Requirement: 健康检查端点
系统 SHALL 提供 `GET /api/health`，无需认证；数据库可达时返回 200，响应体包含数据库往返耗时（毫秒）与当前部署版本标识。

#### Scenario: 数据库正常
- **WHEN** 探活服务请求 `GET /api/health` 且数据库可达
- **THEN** 返回 200，响应体包含 `db.latencyMs` 与 `version`

#### Scenario: 数据库不可达
- **WHEN** 数据库连接失败或超时（超过 5 秒）
- **THEN** 返回 503，响应体标明数据库不可用，且不泄露连接串或主机名

### Requirement: 健康检查不受缓存影响
健康检查的数据库探测 MUST 使用不带查询缓存的数据库连接，使返回结果反映数据库的实时可达性。

#### Scenario: 缓存连接仍有旧结果
- **WHEN** 数据库刚刚停止，而带缓存的连接上仍存有之前的查询结果
- **THEN** 健康检查仍返回 503

### Requirement: 后台 Worker 心跳
后台 Worker 的定时任务 SHALL 每次执行时记录最近一次成功运行的时间，健康检查响应 SHALL 包含该时间，供判断定时任务是否停摆。

#### Scenario: 定时任务正常
- **WHEN** 定时任务按计划运行并成功写库
- **THEN** 健康检查响应中的 `jobs.lastCronAt` 更新为该次运行时间

#### Scenario: 定时任务停摆
- **WHEN** 定时任务超过两个调度周期未成功运行
- **THEN** 健康检查响应中的 `jobs.lastCronAt` 早于两个周期前，探活规则可据此告警
