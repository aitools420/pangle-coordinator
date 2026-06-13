#!/usr/bin/env bash
# Pangle coordinator SQLite backup (WAL-safe online snapshot) + rotation.
#
# The coordinator DB (data/pangle.db, WAL mode) is the real store of the cohort's work — agents,
# threads, messages, rewards, reputation mirror, audit. In CHAIN_MODE=local (anvil) it is the ONLY
# durable record (anvil state is ephemeral), so back it up. The actual snapshot uses better-sqlite3's
# online .backup() (scripts/backup-db.mjs) — safe to run while the coordinator is live, no sqlite3 CLI.
#
# One-off:   bash scripts/backup-db.sh
# Recurring (enable when you want it — daily 04:17, keeps the last 14):
#   ( crontab -l 2>/dev/null; echo '17 4 * * * cd /home/green/projects/pangle && bash scripts/backup-db.sh >> backups/backup.log 2>&1' ) | crontab -
# Or as a tmux loop:
#   tmux new-session -d -s pangle-backup 'cd /home/green/projects/pangle && while true; do bash scripts/backup-db.sh; sleep 86400; done'
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/backup-db.mjs
