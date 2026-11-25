#!/usr/bin/env bash
# 清理残留的 worktree 数据库：删除没有对应 git worktree 的 saas_wt_* 库。
# PR 合并后 Orca 自动移除 worktree 时不运行 archive hook，数据库会残留（见 docs/09-parallel-plan.md §6）。
# 用法：在主 checkout 运行 `bash scripts/orca/prune-dbs.sh` 只列出；加 `--apply` 才删除。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/orca/lib.sh
source "$(dirname "$0")/lib.sh"

apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

if ! pg_available; then
  echo "[orca-prune] 本地 Postgres 容器 $PG_CONTAINER 未运行" >&2
  exit 1
fi

# 现存 worktree 按 archive.sh 的同一规则推导库名，这些库保留
keep=$(git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r path; do
  ORCA_WORKSPACE_NAME="" ORCA_WORKTREE_PATH="$path" worktree_db_name
  echo
done)

orphans=()
while read -r db; do
  [[ -z "$db" || "$db" != saas_wt_* || "$db" == "saas_wt_" ]] && continue
  grep -qxF "$db" <<<"$keep" || orphans+=("$db")
done < <(pg_exec "select datname from pg_database where datname like 'saas\_wt\_%' order by 1")

if ((${#orphans[@]} == 0)); then
  echo "[orca-prune] 没有残留的 worktree 数据库"
  exit 0
fi

for db in "${orphans[@]}"; do
  if ((apply)); then
    pg_exec "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null
    echo "[orca-prune] 已删除 $db"
  else
    echo "[orca-prune] 残留 ${db}（加 --apply 删除）"
  fi
done
