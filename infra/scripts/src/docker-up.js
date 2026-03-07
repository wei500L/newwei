const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } = require('node:fs');
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
const log = (message) => process.stdout.write(`${nowIso()} [docker-up] ${message}\n`);
const logError = (message) => process.stderr.write(`${nowIso()} [docker-up] ${message}\n`);
const resolveCommandForSpawn = (command, args) => {
  if (process.platform !== 'win32' || command !== 'pnpm') {
    return { command, args };
  }

  const npmExecPath = process.env.npm_execpath;
  const npmExecBaseName = npmExecPath ? path.basename(npmExecPath) : '';
  if (npmExecPath && /pnpm(?:\.c?js)?$/i.test(npmExecBaseName)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args]
    };
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', 'pnpm', ...args]
  };
};

const run = (command, args, cwd) => {
  const startedAt = Date.now();
  const resolved = resolveCommandForSpawn(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) {
    logError(`Failed to execute command: ${formatCommand(command, args)}`);
    logError(`           ${result.error.message}`);
  }
  if (result.status !== 0) {
    logError(
      `Command exited with code ${result.status ?? 1}: ${formatCommand(command, args)} (${Date.now() - startedAt}ms)`
    );
    process.exit(result.status ?? 1);
  }
};

const runCapture = (command, args, cwd) => {
  const startedAt = Date.now();
  const resolved = resolveCommandForSpawn(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    shell: false
  });
  if (result.error) {
    logError(`Failed to execute command: ${formatCommand(command, args)}`);
    logError(`           ${result.error.message}`);
  }
  if (result.status !== 0) {
    logError(
      `Command exited with code ${result.status ?? 1}: ${formatCommand(command, args)} (${Date.now() - startedAt}ms)`
    );
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? "").toString();
};

const runWithStatusCapture = (command, args, cwd, options = {}) => {
  const resolved = resolveCommandForSpawn(command, args);
  return spawnSync(resolved.command, resolved.args, {
    cwd,
    stdio: options.stdio ?? ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: options.env,
    timeout: options.timeout,
    shell: false
  });
};

const captureOutput = (result) =>
  `${(result.stdout ?? '').toString()}${(result.stderr ?? '').toString()}`;

const printCapturedOutput = (result) => {
  const stdout = (result.stdout ?? '').toString();
  const stderr = (result.stderr ?? '').toString();
  if (stdout.length > 0) {
    process.stdout.write(stdout);
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }
};

const isFlagWithValue = (flag, arg) => arg === flag || arg.startsWith(`${flag}=`);

const hasProfile = (globalArgs, profileName) => {
  for (let i = 0; i < globalArgs.length; i += 1) {
    const arg = globalArgs[i] ?? "";
    if (arg === "--profile") {
      const value = globalArgs[i + 1];
      if (value === profileName) return true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (value === profileName) return true;
    }
  }
  return false;
};

const knownExtrasServices = new Map([]);

const splitComposeArgs = (args) => {
  const globalArgs = [];
  const upArgs = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";

    if (isFlagWithValue("--profile", arg)) {
      globalArgs.push(arg);
      if (arg === "--profile") {
        const value = args[i + 1];
        if (value) {
          globalArgs.push(value);
          i += 1;
        }
      }
      continue;
    }

    if (isFlagWithValue("--project-name", arg) || isFlagWithValue("-p", arg)) {
      globalArgs.push(arg);
      if (arg === "--project-name" || arg === "-p") {
        const value = args[i + 1];
        if (value) {
          globalArgs.push(value);
          i += 1;
        }
      }
      continue;
    }

    upArgs.push(arg);
  }

  return { globalArgs, upArgs };
};

const dockerImageExists = (imageRef, cwd) => {
  const result = spawnSync('docker', ['image', 'inspect', imageRef], {
    cwd,
    stdio: 'ignore',
    shell: false
  });
  return result.status === 0;
};

const listRunningComposeServices = (composeBaseArgs, cwd) => {
  const output = runCapture(
    'docker',
    [...composeBaseArgs, 'ps', '--status', 'running', '--services'],
    cwd
  );
  return new Set(
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
  );
};

const collectRedisAofDiagnostics = (composeBaseArgs, cwd) => {
  const diagnostics = [
    {
      title: 'Redis service status',
      args: [...composeBaseArgs, 'ps', '--all', 'redis']
    },
    {
      title: 'Latest persisted Redis AOF incident logs',
      args: [
        ...composeBaseArgs,
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        'sh',
        'redis',
        '-ec',
        [
          'set -eu',
          'BACKUP_ROOT="${REDIS_AOF_BACKUP_ROOT:-/data/aof-backups}"',
          'INCIDENT_DIR="${REDIS_AOF_INCIDENT_DIR:-${BACKUP_ROOT}/incidents}"',
          'TAIL_LINES="${REDIS_AOF_PREFLIGHT_LOG_TAIL:-40}"',
          'echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [docker-up][redis-preflight][INFO] Incident directory: $INCIDENT_DIR"',
          'if [ ! -d "$INCIDENT_DIR" ]; then',
          '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [docker-up][redis-preflight][INFO] No incident directory found yet"',
          '  exit 0',
          'fi',
          'latest="$(ls -1t "$INCIDENT_DIR" 2>/dev/null | head -n 3 || true)"',
          'if [ -z "$latest" ]; then',
          '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [docker-up][redis-preflight][INFO] Incident directory is empty"',
          '  exit 0',
          'fi',
          'echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [docker-up][redis-preflight][INFO] Showing up to 3 latest incident logs"',
          "printf '%s\\n' \"$latest\" | while IFS= read -r name; do",
          '  file="$INCIDENT_DIR/$name"',
          '  [ -f "$file" ] || continue',
          '  echo "--- $file (tail=$TAIL_LINES) ---"',
          '  tail -n "$TAIL_LINES" "$file" || true',
          'done'
        ].join('\n')
      ]
    }
  ];

  for (const diagnostic of diagnostics) {
    log(`Collecting diagnostics: ${diagnostic.title}`);
    const result = runWithStatusCapture('docker', diagnostic.args, cwd);
    printCapturedOutput(result);
    if (result.error) {
      logError(`Failed to execute diagnostic command: ${summarizeCommand('docker', diagnostic.args)}`);
      logError(`           ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      logError(
        `Diagnostic command exited with code ${result.status ?? 1}: ${summarizeCommand('docker', diagnostic.args)}`
      );
    }
  }
};

const redisPreflightErrorHint = (statusCode) => {
  if (statusCode === 18) {
    return [
      'Redis AOF is corrupted and auto-repair is disabled by REDIS_AOF_PREFLIGHT_AUTO_REPAIR.',
      'Set REDIS_AOF_PREFLIGHT_AUTO_REPAIR=true in infra/docker/.env or run `pnpm docker:redis:repair`.'
    ];
  }
  if (statusCode === 19 || statusCode === 20) {
    return [
      'Redis AOF preflight attempted repair but validation still failed.',
      'Run `pnpm docker:redis:repair` and inspect /data/aof-backups/incidents for root-cause diagnostics.'
    ];
  }
  return [
    'Redis AOF integrity check failed before startup.',
    'Run `pnpm docker:redis:repair` and retry.',
    'If repeated, inspect backup snapshots in the redis volume under /data/aof-backups.'
  ];
};

const validateRedisAofForDockerUp = (composeBaseArgs, cwd) => {
  const checkScript = [
    'set -eu',
    'AOF_DIR="${REDIS_AOF_DIR:-/data/appendonlydir}"',
    'AOF_MANIFEST="$AOF_DIR/appendonly.aof.manifest"',
    'LEGACY_AOF="$AOF_DIR/appendonly.aof"',
    'CHECK_LOG="/tmp/redis-aof-check.log"',
    'FIX_LOG="/tmp/redis-aof-fix.log"',
    'BACKUP_ROOT="${REDIS_AOF_BACKUP_ROOT:-/data/aof-backups}"',
    'BACKUP_KEEP="${REDIS_AOF_BACKUP_KEEP:-5}"',
    'INCIDENT_DIR="${REDIS_AOF_INCIDENT_DIR:-${BACKUP_ROOT}/incidents}"',
    'AUTO_REPAIR="${REDIS_AOF_PREFLIGHT_AUTO_REPAIR:-true}"',
    'LOG_TAIL="${REDIS_AOF_PREFLIGHT_LOG_TAIL:-40}"',
    'RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"',
    'LAST_BACKUP_DIR=""',
    'timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
    'log() { level="$1"; shift; echo "$(timestamp) [docker-up][redis-preflight][$level][run:$RUN_ID] $*"; }',
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
    '  log INFO "Saved diagnostic log: $incident_file"',
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
    '    log INFO "Pruned old AOF backup: $BACKUP_ROOT/$name"',
    '  done',
    '}',
    'backup_aof_dir() {',
    '  backup_ts="$(date -u +%Y%m%dT%H%M%SZ)-$$"',
    '  backup_dir="$BACKUP_ROOT/appendonlydir-$backup_ts"',
    '  mkdir -p "$BACKUP_ROOT"',
    '  cp -a "$AOF_DIR" "$backup_dir"',
    '  LAST_BACKUP_DIR="$backup_dir"',
    '  log WARN "Backed up AOF data to $backup_dir"',
    '  prune_backups',
    '}',
    "target=''",
    'if [ -f "$AOF_MANIFEST" ]; then',
    '  target="$AOF_MANIFEST"',
    'elif [ -f "$LEGACY_AOF" ]; then',
    '  target="$LEGACY_AOF"',
    'fi',
    'if [ -z "$target" ]; then',
    '  log INFO "No AOF files found (fresh volume)"',
    '  exit 0',
    'fi',
    'if redis-check-aof "$target" >"$CHECK_LOG" 2>&1; then',
    '  log INFO "AOF integrity check passed for $target"',
    '  exit 0',
    'fi',
    'persist_log "$CHECK_LOG" "check-failed"',
    'log ERROR "Corrupted AOF detected at $target"',
    'if [ -s "$CHECK_LOG" ]; then',
    '  log WARN "redis-check-aof validation summary (tail=$LOG_TAIL):"',
    '  tail -n "$LOG_TAIL" "$CHECK_LOG"',
    'fi',
    'if [ "$AUTO_REPAIR" != "true" ]; then',
    '  log ERROR "REDIS_AOF_PREFLIGHT_AUTO_REPAIR=$AUTO_REPAIR, refusing automatic repair"',
    '  exit 18',
    'fi',
    'backup_aof_dir',
    'log WARN "Running redis-check-aof --fix for $target"',
    "if ! printf 'y\\n' | redis-check-aof --fix \"$target\" >\"$FIX_LOG\" 2>&1; then",
    '  persist_log "$FIX_LOG" "fix-failed"',
    '  log ERROR "redis-check-aof --fix failed for $target"',
    '  if [ -s "$FIX_LOG" ]; then',
    '    tail -n "$LOG_TAIL" "$FIX_LOG"',
    '  fi',
    '  exit 19',
    'fi',
    'persist_log "$FIX_LOG" "fix"',
    'if ! redis-check-aof "$target" >"$CHECK_LOG" 2>&1; then',
    '  persist_log "$CHECK_LOG" "post-fix-check-failed"',
    '  log ERROR "AOF remains invalid after repair for $target"',
    '  if [ -s "$CHECK_LOG" ]; then',
    '    tail -n "$LOG_TAIL" "$CHECK_LOG"',
    '  fi',
    '  exit 20',
    'fi',
    'persist_log "$CHECK_LOG" "post-fix-check"',
    'log WARN "AOF repair completed and validation passed"',
    'log WARN "Repair backup location: $LAST_BACKUP_DIR"',
    'exit 0'
  ].join('\n');

  const args = [...composeBaseArgs, 'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'redis', '-ec', checkScript];
  const result = runWithStatusCapture('docker', args, cwd);
  printCapturedOutput(result);

  if (result.error) {
    logError(`Failed to execute command: ${summarizeCommand('docker', args)}`);
    logError(`           ${result.error.message}`);
    process.exit(1);
  }

  if (result.status === 0) return;

  collectRedisAofDiagnostics(composeBaseArgs, cwd);
  logError(redisPreflightErrorHint(result.status ?? 1).join('\n'));
  process.exit(result.status ?? 1);
};

const ensurePnpmLockfileForDockerUp = (repoRoot) => {
  log('Validating pnpm lockfile consistency...');
  const pnpmEnv = {
    ...process.env,
    CI: process.env.CI ?? 'true'
  };
  const lockfileCheckWorkspaceDir = path.resolve(repoRoot, '.cache/docker-up/pnpm-lockfile-check');
  const tempModulesDir = path.join(lockfileCheckWorkspaceDir, 'node_modules');
  const tempVirtualStoreDir = path.join(lockfileCheckWorkspaceDir, '.pnpm');
  const isolatedInstallArgs = [
    '--modules-dir',
    tempModulesDir,
    '--virtual-store-dir',
    tempVirtualStoreDir,
    '--config.confirmModulesPurge=false'
  ];
  const checkArgs = [
    'install',
    '--frozen-lockfile',
    '--lockfile-only',
    '--ignore-scripts',
    ...isolatedInstallArgs
  ];
  try {
    rmSync(lockfileCheckWorkspaceDir, { recursive: true, force: true });
    mkdirSync(lockfileCheckWorkspaceDir, { recursive: true });
    log(`Using isolated pnpm workspace: ${lockfileCheckWorkspaceDir}`);

    const checkResult = runWithStatusCapture('pnpm', checkArgs, repoRoot, {
      env: pnpmEnv,
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (checkResult.error) {
      if (checkResult.error.code === 'ETIMEDOUT') {
        logError('pnpm lockfile preflight timed out after 120s (likely waiting on an interactive prompt or lock).');
        logError(`           Try manually: ${summarizeCommand('pnpm', checkArgs)}`);
      }
      logError(`Failed to execute command: ${summarizeCommand('pnpm', checkArgs)}`);
      logError(`           ${checkResult.error.message}`);
      process.exit(1);
    }

    if (checkResult.status === 0) {
      log('pnpm lockfile consistency verified.');
      return;
    }

    const isOutdatedLockfile = captureOutput(checkResult).includes('ERR_PNPM_OUTDATED_LOCKFILE');
    if (!isOutdatedLockfile) {
      printCapturedOutput(checkResult);
      logError('pnpm lockfile preflight failed.');
      process.exit(checkResult.status ?? 1);
    }

    printCapturedOutput(checkResult);
    log('pnpm-lock.yaml is outdated; synchronizing lockfile...');
    const syncArgs = [
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      ...isolatedInstallArgs
    ];
    const syncResult = runWithStatusCapture('pnpm', syncArgs, repoRoot, {
      env: pnpmEnv,
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    printCapturedOutput(syncResult);

    if (syncResult.error) {
      if (syncResult.error.code === 'ETIMEDOUT') {
        logError('pnpm lockfile synchronization timed out after 120s (likely waiting on an interactive prompt or lock).');
        logError(`           Try manually: ${summarizeCommand('pnpm', syncArgs)}`);
      }
      logError(`Failed to execute command: ${summarizeCommand('pnpm', syncArgs)}`);
      logError(`           ${syncResult.error.message}`);
      process.exit(1);
    }

    if (syncResult.status !== 0) {
      logError('Unable to synchronize pnpm-lock.yaml automatically.');
      process.exit(syncResult.status ?? 1);
    }

    log('pnpm-lock.yaml synchronized.');
  } finally {
    try {
      rmSync(lockfileCheckWorkspaceDir, { recursive: true, force: true });
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
      logError(`Failed to clean isolated pnpm workspace: ${message}`);
    }
  }
};

const resolveUpServices = (upArgs, services) => {
  const serviceNames = new Set(Object.keys(services));
  const explicit = upArgs.filter((arg) => arg && !arg.startsWith('-') && serviceNames.has(arg));

  if (explicit.length === 0) {
    return new Set(serviceNames);
  }

  const resolved = new Set();
  const visit = (serviceName) => {
    if (!serviceName || resolved.has(serviceName)) return;
    if (!serviceNames.has(serviceName)) return;
    resolved.add(serviceName);

    const service = services[serviceName];
    const dependsOn = service && service.depends_on;
    const deps = Array.isArray(dependsOn)
      ? dependsOn
      : dependsOn && typeof dependsOn === 'object'
        ? Object.keys(dependsOn)
        : [];
    for (const dep of deps) {
      visit(dep);
    }
  };

  explicit.forEach(visit);
  return resolved;
};

const collectMigrationSqlFiles = (dirPath) => {
  if (!existsSync(dirPath)) return [];

  const entries = readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMigrationSqlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'migration.sql') {
      files.push(fullPath);
    }
  }
  return files;
};

const lineNumberFromOffset = (source, offset) => {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
};

const findMigrationIdentifierViolations = (migrationsDir, maxLength) => {
  const sqlFiles = collectMigrationSqlFiles(migrationsDir);
  const patterns = [/(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/g, /CONSTRAINT\s+`([^`]+)`/g];
  const violations = [];
  const seen = new Set();

  for (const filePath of sqlFiles) {
    const sql = readFileSync(filePath, 'utf8');
    for (const pattern of patterns) {
      let match = pattern.exec(sql);
      while (match) {
        const identifier = match[1];
        if (identifier && identifier.length > maxLength) {
          const line = lineNumberFromOffset(sql, match.index);
          const key = `${filePath}:${line}:${identifier}`;
          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              filePath,
              identifier,
              length: identifier.length,
              line
            });
          }
        }
        match = pattern.exec(sql);
      }
    }
  }

  return violations;
};

const validateMigrationIdentifiersForDockerUp = (repoRoot) => {
  const maxLength = 64;
  const migrationsDir = path.resolve(repoRoot, 'packages/db/prisma/migrations');
  const violations = findMigrationIdentifierViolations(migrationsDir, maxLength);
  if (violations.length === 0) return;

  violations.sort(
    (a, b) =>
      b.length - a.length ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.identifier.localeCompare(b.identifier)
  );

  const details = violations.map((violation) => {
    const relativePath = path.relative(repoRoot, violation.filePath) || violation.filePath;
    return `${violation.length}\t${violation.identifier}\t${relativePath}:${violation.line}`;
  });

  process.stderr.write(
    [
      `[docker-up] Found migration identifier(s) longer than ${maxLength} characters (MySQL limit).`,
      '[docker-up] Fix by setting `map:` on @@index/@@unique in packages/db/prisma/schema.prisma',
      '[docker-up] or shortening the identifier in migration.sql.',
      '',
      ...details
    ].join('\n') + '\n'
  );
  process.exit(1);
};

const validatePrismaSchemaForDockerUp = (repoRoot) => {
  const args = ['--filter', '@modular/db', 'exec', 'prisma', 'validate', '--schema', 'prisma/schema.prisma'];
  const validationEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://root:secret@127.0.0.1:3306/app'
  };

  const result = runWithStatusCapture('pnpm', args, repoRoot, {
    env: validationEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 120_000
  });
  printCapturedOutput(result);

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      logError('Prisma schema preflight timed out after 120s.');
      logError(`           Try manually: ${summarizeCommand('pnpm', args)}`);
    }
    logError(`Failed to execute command: ${summarizeCommand('pnpm', args)}`);
    logError(`           ${result.error.message}`);
    process.exit(1);
  }

  if (result.status === 0) {
    log('Prisma schema syntax verified.');
    return;
  }

  logError('Prisma schema validation failed. Fix packages/db/prisma/schema.prisma and retry.');
  process.exit(result.status ?? 1);
};

const main = () => {
  const scriptsDir = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(scriptsDir, "../..");
  const dockerDir = path.resolve(scriptsDir, '../docker');
  const envFile = path.resolve(dockerDir, '.env');
  const composeFile = path.resolve(dockerDir, 'docker-compose.yml');

  const userArgs = process.argv.slice(2);
  let { globalArgs, upArgs } = splitComposeArgs(userArgs);
  const requestedServices = upArgs.filter((arg) => arg && !arg.startsWith('-'));
  log(
    `Starting docker up with args: ${userArgs.length > 0 ? userArgs.join(' ') : '(default)'}`
  );

  const wantsExtrasProfile = requestedServices.some((name) => knownExtrasServices.has(name));
  if (wantsExtrasProfile && !hasProfile(globalArgs, 'extras')) {
    globalArgs = [...globalArgs, '--profile', 'extras'];
  }

  const composeBaseArgs = [
    'compose',
    '--env-file',
    envFile,
    '-f',
    composeFile,
    ...globalArgs
  ];

  const rawConfig = runCapture(
    'docker',
    [...composeBaseArgs, 'config', '--format', 'json'],
    scriptsDir
  );
  const config = JSON.parse(rawConfig);
  const projectName = config.name ?? 'docker';
  const services = config.services ?? {};

  const serviceNames = new Set(Object.keys(services));
  const unknownServices = requestedServices.filter((name) => !serviceNames.has(name));
  if (unknownServices.length > 0) {
    logError(
      `Unknown service(s): ${unknownServices.join(', ')}\n` +
        `           Available: ${Array.from(serviceNames).sort().join(', ')}`
    );
    const hints = unknownServices
      .map((name) => knownExtrasServices.get(name))
      .filter(Boolean);
    if (hints.length > 0) {
      logError(`           Hint: ${hints.join(' | ')}`);
    }
    process.exit(1);
  }

  const upServices = resolveUpServices(upArgs, services);

  if (upServices.has('api')) {
    log('Validating Prisma migration identifiers...');
    validateMigrationIdentifiersForDockerUp(repoRoot);
    log('Validating Prisma schema syntax...');
    validatePrismaSchemaForDockerUp(repoRoot);
  }

  const nodeWorkspaceServices = ['api', 'vector', 'web'];
  const shouldValidatePnpmLockfile = nodeWorkspaceServices.some((serviceName) =>
    upServices.has(serviceName)
  );
  if (shouldValidatePnpmLockfile) {
    ensurePnpmLockfileForDockerUp(repoRoot);
  }

  if (upServices.has('redis')) {
    const runningServices = listRunningComposeServices(composeBaseArgs, scriptsDir);
    if (runningServices.has('redis')) {
      log('Redis already running; skipping offline AOF preflight.');
    } else {
      log('Validating Redis AOF integrity...');
      validateRedisAofForDockerUp(composeBaseArgs, scriptsDir);
    }
  }

  const buildServices = Object.entries(services)
    .filter(([name, service]) => upServices.has(name) && Boolean(service && service.build))
    .map(([name]) => name);

  const missingBuildImages = buildServices.filter((serviceName) => {
    const imageRef = `${projectName}-${serviceName}:latest`;
    return !dockerImageExists(imageRef, scriptsDir);
  });

  const pullServices = Object.entries(services)
    .filter(([name, service]) => upServices.has(name) && typeof (service && service.image) === 'string')
    .map(([name]) => name);

  const missingPullImages = pullServices.filter((serviceName) => {
    const imageRef = services[serviceName] && services[serviceName].image;
    if (!imageRef) return false;
    return !dockerImageExists(imageRef, scriptsDir);
  });

  if (missingPullImages.length > 0) {
    run('docker', [...composeBaseArgs, 'pull', ...missingPullImages], scriptsDir);
  }

  if (missingBuildImages.length > 0) {
    run('docker', [...composeBaseArgs, 'build', ...missingBuildImages], scriptsDir);
  }

  run('docker', [...composeBaseArgs, 'up', ...upArgs], scriptsDir);
};

main();
