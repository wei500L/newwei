const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");
const composeFile = path.join(repoRoot, "infra/docker/docker-compose.yml");
const smokeComposeFile = path.join(
  repoRoot,
  "infra/docker/docker-compose.ais-startup-smoke.yml",
);
const envFile = path.join(repoRoot, "infra/docker/.env");

const portBase = 45000 + ((process.pid % 1000) * 10);
const smokePorts = {
  MYSQL_HOST_PORT: String(portBase + 1),
  REDIS_HOST_PORT: String(portBase + 2),
  MONGO_HOST_PORT: String(portBase + 3),
  AKSHARE_PORT: String(portBase + 4),
  MODEL_SERVICE_PORT: String(portBase + 5),
  AIS_RELAY_PORT: String(portBase + 6),
  API_HOST_PORT: String(portBase + 7),
};

const projectName = `ais-startup-smoke-${Date.now()}-${process.pid}`;
const composeArgs = [
  "compose",
  "--env-file",
  envFile,
  "-f",
  composeFile,
  "-f",
  smokeComposeFile,
  "-p",
  projectName,
];

const nowIso = () => new Date().toISOString();
const log = (message) =>
  process.stdout.write(`${nowIso()} [ais-startup-smoke] ${message}\n`);
const logError = (message) =>
  process.stderr.write(`${nowIso()} [ais-startup-smoke] ${message}\n`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = (args, options = {}) => {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      ...smokePorts,
    },
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    if (stdout) {
      process.stdout.write(`${stdout}\n`);
    }
    if (stderr) {
      process.stderr.write(`${stderr}\n`);
    }
    throw new Error(`docker ${args.join(" ")} exited with ${result.status}`);
  }
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
};

const compose = (args, options = {}) => run([...composeArgs, ...args], options);

const fetchJson = async (url) => {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
};

const getContainerId = (service) => {
  const { stdout } = compose(["ps", "-q", service], { capture: true });
  return stdout.trim();
};

const inspectHealth = (service) => {
  const containerId = getContainerId(service);
  if (!containerId) {
    return "";
  }

  const { stdout } = run(
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      containerId,
    ],
    { capture: true },
  );
  return stdout.trim();
};

const waitForHealth = async (service, expected, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    lastStatus = inspectHealth(service) || "missing";
    if (lastStatus === expected) {
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    `${service} did not reach health=${expected} within ${timeoutMs}ms (last=${lastStatus})`,
  );
};

const waitForHttpOk = async (name, url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetchJson(url);
      lastStatus = String(response.status);
      if (response.ok) {
        return response.body;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }
  throw new Error(`${name} did not return HTTP 200 within ${timeoutMs}ms (${lastStatus})`);
};

const waitForRelayDegraded = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastPayload = null;
  const url = `http://127.0.0.1:${smokePorts.AIS_RELAY_PORT}/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetchJson(url);
      lastPayload = response.body;
      if (
        response.ok &&
        response.body &&
        typeof response.body === "object" &&
        response.body.status === "degraded" &&
        response.body.diagnostics?.statusReasonCode ===
          "ais_upstream_no_messages_after_connect"
      ) {
        return response.body;
      }
    } catch (error) {
      lastPayload = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }

  throw new Error(
    `ais-relay /health did not report ais_upstream_no_messages_after_connect within ${timeoutMs}ms: ${JSON.stringify(lastPayload)}`,
  );
};

const dumpDiagnostics = () => {
  try {
    compose(["ps"]);
  } catch (error) {
    logError(`failed to print docker compose ps: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    compose(["logs", "--tail", "200", "mock-ais-upstream", "ais-relay", "api"]);
  } catch (error) {
    logError(`failed to print docker compose logs: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const ensurePrerequisites = () => {
  for (const file of [composeFile, smokeComposeFile, envFile]) {
    if (!existsSync(file)) {
      throw new Error(`required file is missing: ${file}`);
    }
  }
};

const main = async () => {
  ensurePrerequisites();
  log(`using compose project ${projectName}`);
  log(
    `isolated host ports api=${smokePorts.API_HOST_PORT} relay=${smokePorts.AIS_RELAY_PORT} mysql=${smokePorts.MYSQL_HOST_PORT} redis=${smokePorts.REDIS_HOST_PORT} mongo=${smokePorts.MONGO_HOST_PORT}`,
  );

  try {
    compose(["up", "-d", "--build", "mock-ais-upstream", "ais-relay", "api"]);
    await waitForHealth("mock-ais-upstream", "healthy", 30_000);
    await waitForHealth("ais-relay", "healthy", 45_000);
    await waitForHealth("api", "healthy", 180_000);

    await waitForHttpOk(
      "api liveness",
      `http://127.0.0.1:${smokePorts.API_HOST_PORT}/api/healthz/live`,
      30_000,
    );

    const relayHealth = await waitForRelayDegraded(30_000);
    const relayContainerHealth = inspectHealth("ais-relay");
    if (relayContainerHealth !== "healthy") {
      throw new Error(
        `ais-relay container health regressed to ${relayContainerHealth} after /health reported degraded`,
      );
    }

    await waitForHttpOk(
      "api liveness after relay degradation",
      `http://127.0.0.1:${smokePorts.API_HOST_PORT}/api/healthz/live`,
      30_000,
    );

    log(
      `relay degraded as expected with reason=${relayHealth.diagnostics.statusReasonCode}, while container health remained ${relayContainerHealth} and api stayed live`,
    );
  } catch (error) {
    dumpDiagnostics();
    throw error;
  } finally {
    try {
      compose(["down", "-v", "--remove-orphans"]);
    } catch (error) {
      logError(
        `failed to tear down compose project ${projectName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

main().catch((error) => {
  logError(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
