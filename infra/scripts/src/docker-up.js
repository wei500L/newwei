const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const runCapture = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? "").toString();
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

const knownExtrasServices = new Map([
  ['crawl4ai', 'pnpm docker:up:extras -d crawl4ai'],
  ['vector', 'pnpm docker:up:extras -d vector'],
  ['qdrant', 'pnpm docker:up:extras -d qdrant']
]);

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

const main = () => {
  const scriptsDir = path.resolve(__dirname, "..");
  const dockerDir = path.resolve(scriptsDir, '../docker');
  const envFile = path.resolve(dockerDir, '.env');
  const composeFile = path.resolve(dockerDir, 'docker-compose.yml');

  const userArgs = process.argv.slice(2);
  let { globalArgs, upArgs } = splitComposeArgs(userArgs);
  const requestedServices = upArgs.filter((arg) => arg && !arg.startsWith('-'));

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
    process.stderr.write(
      `[docker-up] Unknown service(s): ${unknownServices.join(', ')}\n` +
        `           Available: ${Array.from(serviceNames).sort().join(', ')}\n`
    );
    const hints = unknownServices
      .map((name) => knownExtrasServices.get(name))
      .filter(Boolean);
    if (hints.length > 0) {
      process.stderr.write(`           Hint: ${hints.join(' | ')}\n`);
    }
    process.exit(1);
  }

  const upServices = resolveUpServices(upArgs, services);

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
