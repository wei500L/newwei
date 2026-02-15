const { spawnSync } = require('node:child_process');
const path = require('node:path');

const formatCommand = (command, args) => [command, ...args].join(' ');
const summarizeCommand = (command, args) => {
  const singleLine = formatCommand(command, args).replace(/\s+/gu, ' ').trim();
  if (singleLine.length <= 220) {
    return singleLine;
  }
  return `${singleLine.slice(0, 220)}...`;
};
const nowIso = () => new Date().toISOString();
const log = (level, message) => process.stdout.write(`${nowIso()} [redis-repair][${level}] ${message}\n`);
const logError = (message) => process.stderr.write(`${nowIso()} [redis-repair][ERROR] ${message}\n`);

const run = (command, args, cwd, stdio = 'inherit') => {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    stdio,
    shell: false,
    encoding: stdio === 'pipe' ? 'utf8' : undefined
  });
  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    logError(`Failed to execute command: ${summarizeCommand(command, args)}`);
    logError(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    logError(`Command exited with code ${result.status ?? 1}: ${summarizeCommand(command, args)} (${elapsedMs}ms)`);
    process.exit(result.status ?? 1);
  }

  log('INFO', `Command succeeded: ${summarizeCommand(command, args)} (${elapsedMs}ms)`);
  return result.stdout ?? '';
};

const main = () => {
  const scriptsDir = path.resolve(__dirname, '..');
  const dockerDir = path.resolve(scriptsDir, '../docker');
  const envFile = path.resolve(dockerDir, '.env');
  const composeFile = path.resolve(dockerDir, 'docker-compose.yml');

  const composeBaseArgs = ['compose', '--env-file', envFile, '-f', composeFile];
  const compose = (...args) => run('docker', [...composeBaseArgs, ...args], scriptsDir);
  const startedAt = Date.now();

  log('INFO', `Using compose file ${composeFile}`);
  log('INFO', `Using env file ${envFile}`);

  const repairScript = [
    'set -eu',
    "AOF_DIR=\"${REDIS_AOF_DIR:-/data/appendonlydir}\"",
    "AOF_MANIFEST=\"$AOF_DIR/appendonly.aof.manifest\"",
    "LEGACY_AOF=\"$AOF_DIR/appendonly.aof\"",
    "BACKUP_ROOT=\"${REDIS_AOF_BACKUP_ROOT:-/data/aof-backups}\"",
    "BACKUP_KEEP=\"${REDIS_AOF_BACKUP_KEEP:-5}\"",
    "INCIDENT_DIR=\"${REDIS_AOF_INCIDENT_DIR:-${BACKUP_ROOT}/incidents}\"",
    "LOG_TAIL=\"${REDIS_AOF_PREFLIGHT_LOG_TAIL:-40}\"",
    "RUN_ID=\"$(date -u +%Y%m%dT%H%M%SZ)-$$\"",
    "CHECK_LOG='/tmp/redis-aof-check.log'",
    "FIX_LOG='/tmp/redis-aof-fix.log'",
    'parse_positive_int_or_default() {',
    '  value="$1"',
    '  fallback="$2"',
    '  case "$value" in',
    "    '' | *[!0-9]*)",
    '      echo "$fallback"',
    '      return',
    '      ;;',
    '  esac',
    '  if [ "$value" -le 0 ]; then',
    '    echo "$fallback"',
    '    return',
    '  fi',
    '  echo "$value"',
    '}',
    'persist_log() {',
    '  source_file="$1"',
    '  suffix="$2"',
    '  [ -f "$source_file" ] || return',
    '  mkdir -p "$INCIDENT_DIR"',
    '  incident_file="$INCIDENT_DIR/$RUN_ID-$suffix.log"',
    '  cp "$source_file" "$incident_file"',
    "  echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] Saved diagnostic log: $incident_file\"",
    '}',
    'prune_backups() {',
    '  keep="$(parse_positive_int_or_default "$BACKUP_KEEP" 5)"',
    '  [ -d "$BACKUP_ROOT" ] || return',
    "  entries=\"$(find \"$BACKUP_ROOT\" -mindepth 1 -maxdepth 1 -type d -name 'appendonlydir-*' -printf '%f\\n' | sort || true)\"",
    "  total=\"$(printf '%s\\n' \"$entries\" | sed '/^$/d' | wc -l | tr -d ' ')\"",
    '  if [ "$total" -le "$keep" ]; then',
    '    return',
    '  fi',
    '  remove_count=$((total - keep))',
    "  printf '%s\\n' \"$entries\" | sed '/^$/d' | head -n \"$remove_count\" | while IFS= read -r name; do",
    '    rm -rf "$BACKUP_ROOT/$name"',
    "    echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] Pruned old backup: $BACKUP_ROOT/$name\"",
    '  done',
    '}',
    "target=''",
    'if [ -f "$AOF_MANIFEST" ]; then',
    '  target="$AOF_MANIFEST"',
    'elif [ -f "$LEGACY_AOF" ]; then',
    '  target="$LEGACY_AOF"',
    'fi',
    'if [ -z "$target" ]; then',
    "  echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] No AOF file found; nothing to repair\"",
    '  exit 0',
    'fi',
    'if redis-check-aof "$target" >"$CHECK_LOG" 2>&1; then',
    "  echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] AOF is healthy; no repair needed\"",
    '  persist_log "$CHECK_LOG" "check"',
    '  exit 0',
    'fi',
    'persist_log "$CHECK_LOG" "check-failed"',
    "echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][WARN] Corrupted AOF detected\"",
    'tail -n "$LOG_TAIL" "$CHECK_LOG"',
    "timestamp=\"$(date -u +%Y%m%dT%H%M%SZ)\"",
    "backup_dir=\"$BACKUP_ROOT/appendonlydir-$timestamp\"",
    'mkdir -p "$BACKUP_ROOT"',
    'cp -a "$AOF_DIR" "$backup_dir"',
    'prune_backups',
    "echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] Backup saved to $backup_dir\"",
    "echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] Running redis-check-aof --fix\"",
    "if ! printf 'y\\n' | redis-check-aof --fix \"$target\" >\"$FIX_LOG\" 2>&1; then",
    "  echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][ERROR] Repair failed\"",
    '  persist_log "$FIX_LOG" "fix-failed"',
    '  tail -n "$LOG_TAIL" "$FIX_LOG"',
    '  exit 1',
    'fi',
    'persist_log "$FIX_LOG" "fix"',
    'if ! redis-check-aof "$target" >"$CHECK_LOG" 2>&1; then',
    "  echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][ERROR] Post-repair validation failed\"",
    '  persist_log "$CHECK_LOG" "post-fix-check-failed"',
    '  tail -n "$LOG_TAIL" "$CHECK_LOG"',
    '  exit 1',
    'fi',
    'persist_log "$CHECK_LOG" "post-fix-check"',
    "echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) [redis-repair][INFO] Repair completed and validation passed\""
  ].join('\n');

  log('INFO', 'Stopping redis service for offline repair');
  compose('stop', 'redis');

  log('INFO', 'Running offline AOF check/repair container');
  compose('run', '--rm', '--no-deps', '--entrypoint', 'sh', 'redis', '-ec', repairScript);

  log('INFO', 'Starting redis service');
  compose('up', '-d', 'redis');

  log('INFO', `Done in ${Date.now() - startedAt}ms`);
};

main();
