#!/usr/bin/env bash
# Orca worktree setup：在新 worktree 根目录运行。
# 每一步在前置条件不满足时跳过并提示，而不是失败，使脚手架尚未完成时也能创建 worktree。
set -euo pipefail

cd "${ORCA_WORKTREE_PATH:-$PWD}"
# shellcheck source=scripts/orca/lib.sh
source "$(dirname "$0")/lib.sh"

name="$(worktree_name)"
db="$(worktree_db_name)"
base="$(worktree_port_base)"
echo "[orca-setup] worktree=$name db=$db ports=$base-$((base + 9))"

# 1. 依赖
if [[ -f package.json ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  else
    echo "[orca-setup] 未找到 pnpm，跳过依赖安装" >&2
  fi
else
  echo "[orca-setup] 尚无 package.json，跳过依赖安装"
fi

# 2. 专属数据库
if pg_available; then
  if [[ "$(pg_exec "SELECT 1 FROM pg_database WHERE datname = '$db'")" != "1" ]]; then
    pg_exec "CREATE DATABASE \"$db\""
    echo "[orca-setup] 已创建数据库 $db"
  else
    echo "[orca-setup] 数据库 $db 已存在，保留"
  fi
  # 应用账号存在时授予权限（账号由 infra/local 的初始化脚本创建）
  if [[ "$(pg_exec "SELECT 1 FROM pg_roles WHERE rolname = '$PG_APP_USER'")" == "1" ]]; then
    pg_exec "GRANT ALL PRIVILEGES ON DATABASE \"$db\" TO \"$PG_APP_USER\""
  fi
else
  echo "[orca-setup] 本地 Postgres 容器 $PG_CONTAINER 未运行，跳过建库（启动后重新运行 bash scripts/orca/setup.sh）" >&2
fi

# 3. 端口与连接串
db_url="postgres://$PG_APP_USER:$PG_APP_PASSWORD@localhost:$PG_HOST_PORT/$db"
cat > .env.worktree <<EOF
# 由 scripts/orca/setup.sh 生成，勿提交。
WORKTREE_NAME=$name
DATABASE_URL=$db_url
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=$db_url
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED=$db_url
WEB_PORT=$base
JOBS_PORT=$((base + 1))
WEB_INSPECTOR_PORT=$((base + 2))
JOBS_INSPECTOR_PORT=$((base + 3))
EOF
echo "[orca-setup] 已写入 .env.worktree"

# 4. 本地密钥
if [[ ! -f .dev.vars && ! -f apps/web/.dev.vars ]]; then
  echo "[orca-setup] 未找到 .dev.vars（在主 checkout 中创建后会通过 .worktreeinclude 复制到新 worktree）"
fi
