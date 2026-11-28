#!/usr/bin/env bash
# Daily snapshot of everything the company has produced and decided (tasks,
# plans, full prompt/output logs, dashboard state). Keeps 14 days.
# Not included on purpose: .env (secrets) and the Muse browser profile.
# Cron (as aicompany): 30 3 * * * /home/aicompany/Agent_2/deploy/backup.sh
set -euo pipefail
APP_DIR="${APP_DIR:-/home/aicompany/Agent_2}"
BACKUP_DIR="${BACKUP_DIR:-/home/aicompany/backups}"
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/ai-company-$(date +%F).tgz" -C "$APP_DIR" data
find "$BACKUP_DIR" -name 'ai-company-*.tgz' -mtime +14 -delete
