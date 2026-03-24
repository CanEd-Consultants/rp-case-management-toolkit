#!/bin/bash
# Daily backup script for RP Immigration Checklist database
# Usage: ./scripts/backup.sh
# Schedule with cron: 0 2 * * * /path/to/Client\ Checklist\ App/scripts/backup.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
DB_FILE="$APP_DIR/data/checklist.db"
BACKUP_DIR="$APP_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "ERROR: Database file not found at $DB_FILE"
  exit 1
fi

# Copy database file
cp "$DB_FILE" "$BACKUP_DIR/checklist_${TIMESTAMP}.db"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "$BACKUP_DIR/checklist_${TIMESTAMP}.db" | cut -f1)
  echo "Backup created: checklist_${TIMESTAMP}.db ($SIZE)"
else
  echo "ERROR: Backup failed"
  exit 1
fi

# Remove backups older than KEEP_DAYS
DELETED=$(find "$BACKUP_DIR" -name "checklist_*.db" -mtime +$KEEP_DAYS -delete -print | wc -l | tr -d ' ')
if [ "$DELETED" -gt 0 ]; then
  echo "Cleaned up $DELETED backup(s) older than $KEEP_DAYS days"
fi
