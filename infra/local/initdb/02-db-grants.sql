-- 单个数据库的权限设置，作用于当前连接的数据库，可重复执行。
-- 容器初始化时作用于 saas_dev；scripts/orca/setup.sh 对每个 worktree 数据库再执行一次。
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app, migrator, readonly', current_database());
  -- migrator 需要建 schema（drizzle 的迁移记录表位于 drizzle schema）
  EXECUTE format('GRANT CREATE, TEMPORARY ON DATABASE %I TO migrator', current_database());
END
$$;

ALTER SCHEMA public OWNER TO migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app, readonly;

-- 已有对象
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;

-- migrator 今后创建的对象
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO readonly;
