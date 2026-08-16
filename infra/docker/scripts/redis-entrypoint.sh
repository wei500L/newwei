#!/bin/sh
set -eu

AOF_DIR="${REDIS_AOF_DIR:-/data/appendonlydir}"
AOF_MANIFEST="${AOF_DIR}/appendonly.aof.manifest"
LEGACY_AOF="${AOF_DIR}/appendonly.aof"
BACKUP_ROOT="${REDIS_AOF_BACKUP_ROOT:-/data/aof-backups}"
BACKUP_KEEP="${REDIS_AOF_BACKUP_KEEP:-5}"
CHECK_ON_START="${REDIS_AOF_CHECK_ON_START:-true}"
AUTO_FIX="${REDIS_AOF_AUTO_FIX:-false}"
CHECK_LOG='/tmp/redis-aof-check.log'
FIX_LOG='/tmp/redis-aof-fix.log'
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
INCIDENT_DIR="${REDIS_AOF_INCIDENT_DIR:-${BACKUP_ROOT}/incidents}"
LAST_BACKUP_DIR=''

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

log() {
  level="$1"
  shift
  echo "$(timestamp) [redis-entrypoint][$level][run:$RUN_ID] $*"
}

info() {
  log INFO "$@"
}

warn() {
  log WARN "$@"
}

error() {
  log ERROR "$@"
}

persist_diagnostic_log() {
  source_file="$1"
  suffix="$2"
  if [ ! -f "$source_file" ]; then
    return
  fi
  mkdir -p "$INCIDENT_DIR"
  incident_file="${INCIDENT_DIR}/${RUN_ID}-${suffix}.log"
  cp "$source_file" "$incident_file"
  info "Saved diagnostic log: $incident_file"
}

parse_positive_int_or_default() {
  value="$1"
  fallback="$2"
  case "$value" in
    '' | *[!0-9]*)
      echo "$fallback"
      return
      ;;
  esac
  if [ "$value" -le 0 ]; then
    echo "$fallback"
    return
  fi
  echo "$value"
}

detect_aof_target() {
  if [ -f "$AOF_MANIFEST" ]; then
    echo "$AOF_MANIFEST"
    return
  fi
  if [ -f "$LEGACY_AOF" ]; then
    echo "$LEGACY_AOF"
    return
  fi
  echo ''
}

prune_old_backups() {
  keep="$(parse_positive_int_or_default "$BACKUP_KEEP" 5)"
  if [ ! -d "$BACKUP_ROOT" ]; then
    return
  fi

  entries="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'appendonlydir-*' -printf '%f\n' | sort || true)"
  total="$(printf '%s\n' "$entries" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$total" -le "$keep" ]; then
    return
  fi

  remove_count=$((total - keep))
  printf '%s\n' "$entries" | sed '/^$/d' | head -n "$remove_count" | while IFS= read -r name; do
    rm -rf "$BACKUP_ROOT/$name"
    info "Pruned old AOF backup: $BACKUP_ROOT/$name"
  done
}

backup_aof_dir() {
  backup_ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="${BACKUP_ROOT}/appendonlydir-${backup_ts}"
  mkdir -p "$BACKUP_ROOT"
  cp -a "$AOF_DIR" "$backup_dir"
  LAST_BACKUP_DIR="$backup_dir"
  info "Backed up AOF data to $backup_dir"
  prune_old_backups
}

run_aof_check() {
  target="$1"
  redis-check-aof "$target" >"$CHECK_LOG" 2>&1
}

repair_aof() {
  target="$1"
  if ! printf 'y\n' | redis-check-aof --fix "$target" >"$FIX_LOG" 2>&1; then
    persist_diagnostic_log "$FIX_LOG" "fix-failed"
    error "AOF repair failed for $target"
    tail -n 20 "$FIX_LOG" || true
    exit 1
  fi
  persist_diagnostic_log "$FIX_LOG" "fix"
}

info "Startup with check_on_start=$CHECK_ON_START auto_fix=$AUTO_FIX backup_keep=$BACKUP_KEEP aof_dir=$AOF_DIR"

if [ "$CHECK_ON_START" = 'true' ]; then
  aof_target="$(detect_aof_target)"
  if [ -n "$aof_target" ]; then
    if ! run_aof_check "$aof_target"; then
      persist_diagnostic_log "$CHECK_LOG" "check-failed"
      error "Detected corrupted AOF data at $aof_target"
      if [ -s "$CHECK_LOG" ]; then
        warn "redis-check-aof validation summary:"
        tail -n 12 "$CHECK_LOG"
      fi

      if [ "$AUTO_FIX" != 'true' ]; then
        error "REDIS_AOF_AUTO_FIX is disabled; refusing to start with corrupted AOF"
        error "Run 'pnpm docker:redis:repair' to perform an explicit offline repair"
        exit 1
      fi

      backup_aof_dir
      warn "Repairing AOF files with redis-check-aof --fix (target=$aof_target backup=$LAST_BACKUP_DIR)"
      repair_aof "$aof_target"

      if ! run_aof_check "$aof_target"; then
        persist_diagnostic_log "$CHECK_LOG" "post-fix-check-failed"
        error "AOF remains invalid after repair for $aof_target"
        if [ -s "$CHECK_LOG" ]; then
          tail -n 12 "$CHECK_LOG"
        fi
        exit 1
      fi
      persist_diagnostic_log "$CHECK_LOG" "post-fix-check"
      info "AOF repair completed and validation passed"
    else
      info "AOF integrity check passed for $aof_target"
    fi
  else
    info "AOF check enabled but no AOF target found (fresh or non-AOF data directory)"
  fi
else
  warn "AOF integrity check is disabled by REDIS_AOF_CHECK_ON_START=false"
fi

info "Starting redis-server"
if [ -z "${REDIS_PASSWORD:-}" ]; then
  error "REDIS_PASSWORD is required; refusing to start Redis without AUTH"
  exit 1
fi
exec redis-server --save '' --appendonly yes --requirepass "$REDIS_PASSWORD"
