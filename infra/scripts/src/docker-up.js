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

const main = () => {
  const scriptsDir = path.resolve(__dirname, "..");
  const dockerDir = path.resolve(scriptsDir, '../docker');
  const envFile = path.resolve(dockerDir, '.env');
  const composeFile = path.resolve(dockerDir, 'docker-compose.yml');

  const userArgs = process.argv.slice(2);
  const { globalArgs, upArgs } = splitComposeArgs(userArgs);

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

  const buildServices = Object.entries(services)
    .filter(([, service]) => Boolean(service && service.build))
    .map(([name]) => name);

  const missingBuildImages = buildServices.filter((serviceName) => {
    const imageRef = `${projectName}-${serviceName}:latest`;
    return !dockerImageExists(imageRef, scriptsDir);
  });

  const pullServices = Object.entries(services)
    .filter(([, service]) => typeof (service && service.image) === 'string')
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
