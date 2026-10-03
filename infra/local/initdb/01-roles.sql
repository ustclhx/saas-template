-- 集群级账号（只在容器首次初始化时执行）。本地密码与账号名相同，仅用于开发。
--   app      : 业务表 DML，Hyperdrive / 应用运行时使用
--   migrator : DDL，drizzle-kit migrate / push 使用，拥有 public schema 与其中的表
--   readonly : 只读查询
CREATE ROLE app LOGIN PASSWORD 'app';
CREATE ROLE migrator LOGIN PASSWORD 'migrator';
CREATE ROLE readonly LOGIN PASSWORD 'readonly';
