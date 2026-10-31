import { EventEmitter } from "node:events";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDevPlan,
  findDuplicateEnvKeys,
  parseEnvText,
  resolveRepoRootFromModuleUrl,
} from "../../../infra/scripts/src/dev-config";
import { runChildren } from "../../../infra/scripts/src/dev-process";

/**
 * Behavioural cover for the local development launcher.
 *
 * The shipped `.env.example` is the input an operator actually copies, so the
 * tests feed that file into the same resolver the `pnpm dev` CLI uses and assert
 * the resolved child environments, ports and addresses -- not source text. The
 * process-lifecycle cases use local `node -e` children only; they never start
 * Go, Nest, Docker or any network service.
 */

const repoRoot = path.resolve(process.cwd(), "../..");
const examplePath = path.join(repoRoot, ".env.example");
const exampleText = readFileSync(examplePath, "utf8");
const exampleEnv = parseEnvText(exampleText);

function environmentWithStrings(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function modeEntries(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => /^API_GO_[A-Z0-9_]+_MODE$/u.test(key)),
  );
}

describe("local dev launcher configuration", () => {
  it("resolves the repository root from the module URL, not process.cwd", () => {
    expect(
      resolveRepoRootFromModuleUrl("file:///tmp/example/newwei/infra/scripts/src/dev.mts"),
    ).toBe("/tmp/example/newwei");
  });

  it("keeps the shipped .env.example on the all-Go default", () => {
    expect(findDuplicateEnvKeys(exampleText)).toEqual([]);
    const modes = modeEntries(exampleEnv);
    expect(modes.API_GO_LEGACY_FALLBACK_MODE).toBe("reject");
    for (const [key, value] of Object.entries(modes)) {
      if (key === "API_GO_LEGACY_FALLBACK_MODE") {
        continue;
      }
      expect(value, key).toBe("go");
    }
    expect(exampleEnv.CANARY_PERCENT).toBe("0");
    expect(exampleEnv.API_BASE_URL).toBe("http://localhost:4020");
    expect(exampleEnv.NEXT_PUBLIC_API_BASE_URL).toBe(
      "http://localhost:4020/api",
    );
    expect(exampleEnv.NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH).toBe(
      "/socket.io-notifications",
    );
    expect(exampleEnv.NEXT_PUBLIC_REALTIME_SOCKET_PATH).toBe(
      "/socket.io-realtime",
    );
    expect(exampleEnv.VECTOR_SERVICE_BASE_URL).toBe("http://localhost:4010");
    expect(exampleEnv.REALTIME_SIGNALS_AIS_BASE_URL).toBe(
      "http://localhost:3004",
    );
  });

  it("keeps both checked-in mode samples complete and duplicate-free", () => {
    const goSampleText = readFileSync(
      path.join(repoRoot, "infra", "docker", "api-go-cutover.env.sample"),
      "utf8",
    );
    const legacySampleText = readFileSync(
      path.join(repoRoot, "infra", "docker", "legacy-rollback.env.sample"),
      "utf8",
    );
    expect(findDuplicateEnvKeys(goSampleText)).toEqual([]);
    expect(findDuplicateEnvKeys(legacySampleText)).toEqual([]);

    const goModes = modeEntries(parseEnvText(goSampleText));
    const legacyModes = modeEntries(parseEnvText(legacySampleText));
    expect(Object.keys(goModes)).toHaveLength(137);
    expect(Object.keys(legacyModes)).toHaveLength(137);
    expect(goModes.API_GO_LEGACY_FALLBACK_MODE).toBe("reject");
    expect(legacyModes.API_GO_LEGACY_FALLBACK_MODE).toBe("proxy");
    expect(legacyModes.API_GO_ONBOARDING_MODE).toBe("shadow");
    expect(legacyModes.API_GO_USER_SETTINGS_READ_MODE).toBe("shadow");
  });

  it("starts only the Go chain on independent ports and derives DATABASE_URL", () => {
    const plan = buildDevPlan({
      mode: "go",
      repoRoot,
      fileEnv: exampleEnv,
      processEnv: {
        MYSQL_PASSWORD: "test-only-password",
        JWT_SECRET: "test-only-jwt-secret",
        SYSTEM_SETTINGS_ENCRYPTION_KEY: "0".repeat(64),
      },
    });

    expect(plan.children.map((child) => child.name)).toEqual([
      "api-go",
      "vector-go",
      "web",
    ]);
    const [apiGo, vectorGo, web] = plan.children;
    if (!apiGo || !vectorGo || !web) {
      throw new Error("expected three Go-chain children");
    }
    expect(apiGo.env.PORT).toBe("4020");
    expect(vectorGo.env.PORT).toBe("4010");
    expect(web.env.PORT).toBe("3000");
    expect(web.args).toEqual(["run", "dev", "--", "--port", "3000"]);
    expect(apiGo.env.DATABASE_URL).toBe(
      "mysql://root:test-only-password@localhost:3306/app",
    );
    expect(apiGo.env.VECTOR_SERVICE_BASE_URL).toBe("http://localhost:4010");
    expect(apiGo.env.REALTIME_SIGNALS_AIS_BASE_URL).toBe(
      "http://localhost:3004",
    );

    for (const [key, value] of Object.entries(modeEntries(apiGo.env))) {
      expect(value, key).toBe(
        key === "API_GO_LEGACY_FALLBACK_MODE" ? "reject" : "go",
      );
    }
  });

  it("lets an explicitly exported variable win over .env and the mode overlay", () => {
    const plan = buildDevPlan({
      mode: "go",
      repoRoot,
      fileEnv: exampleEnv,
      processEnv: {
        API_BASE_URL: "http://127.0.0.1:4999",
        NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4999/api",
      },
    });

    const [apiGo, , web] = plan.children;
    if (!apiGo || !web) {
      throw new Error("expected three Go-chain children");
    }
    expect(apiGo.env.API_BASE_URL).toBe("http://127.0.0.1:4999");
    expect(web.env.NEXT_PUBLIC_API_BASE_URL).toBe(
      "http://127.0.0.1:4999/api",
    );
  });

  it("applies service-specific port overrides only to their own child", () => {
    const plan = buildDevPlan({
      mode: "go",
      repoRoot,
      fileEnv: exampleEnv,
      processEnv: {
        DEV_GO_API_PORT: "4100",
        DEV_VECTOR_PORT: "4101",
        DEV_WEB_PORT: "3100",
      },
    });

    const [apiGo, vectorGo, web] = plan.children;
    if (!apiGo || !vectorGo || !web) {
      throw new Error("expected three Go-chain children");
    }
    expect(apiGo.env.PORT).toBe("4100");
    expect(vectorGo.env.PORT).toBe("4101");
    expect(web.env.PORT).toBe("3100");
    expect(apiGo.env.API_BASE_URL).toBe("http://localhost:4100");
    expect(web.env.NEXT_PUBLIC_API_BASE_URL).toBe(
      "http://localhost:4100/api",
    );
    expect(vectorGo.env.VECTOR_SERVICE_BASE_URL).toBe(
      "http://localhost:4101",
    );
    expect(apiGo.env.REALTIME_SIGNALS_AIS_BASE_URL).toBe(
      "http://localhost:3004",
    );
    expect(web.env.NEXTAUTH_URL).toBe("http://localhost:3100");
    expect(apiGo.env.CORS_ORIGIN).toBe("http://localhost:3100");
    expect(web.args).toEqual(["run", "dev", "--", "--port", "3100"]);
  });

  it("switches the whole process set and every switch for dev:legacy", () => {
    const plan = buildDevPlan({
      mode: "legacy",
      repoRoot,
      fileEnv: exampleEnv,
      processEnv: {},
    });

    expect(plan.children.map((child) => child.name)).toEqual([
      "api",
      "vector",
      "ais-relay",
      "web",
    ]);
    const [api, vector, aisRelay, web] = plan.children;
    if (!api || !vector || !aisRelay || !web) {
      throw new Error("expected four legacy-chain children");
    }
    expect(api.env.PORT).toBe("4000");
    expect(vector.env.PORT).toBe("4010");
    expect(aisRelay.env.PORT).toBe("3004");
    expect(web.env.PORT).toBe("3000");
    expect(api.env.API_BASE_URL).toBe("http://localhost:4000");
    expect(web.env.NEXT_PUBLIC_API_BASE_URL).toBe(
      "http://localhost:4000/api",
    );
    expect(web.env.NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH).toBe("/socket.io");
    expect(web.env.NEXT_PUBLIC_REALTIME_SOCKET_PATH).toBe("/socket.io");

    const modes = modeEntries(api.env);
    expect(modes.API_GO_LEGACY_FALLBACK_MODE).toBe("proxy");
    expect(modes.API_GO_ONBOARDING_MODE).toBe("shadow");
    expect(modes.API_GO_USER_SETTINGS_READ_MODE).toBe("shadow");
    const legacyModes = Object.entries(modes).filter(
      ([key, value]) =>
        key !== "API_GO_LEGACY_FALLBACK_MODE" &&
        key !== "API_GO_ONBOARDING_MODE" &&
        key !== "API_GO_USER_SETTINGS_READ_MODE" &&
        value === "legacy",
    );
    expect(legacyModes).toHaveLength(134);
  });

  it("starts only the Go AIS relay on the port the API will call", () => {
    const plan = buildDevPlan({
      mode: "ais-relay",
      repoRoot,
      fileEnv: exampleEnv,
      processEnv: {},
    });

    expect(plan.children).toHaveLength(1);
    const [relay] = plan.children;
    if (!relay) {
      throw new Error("expected one AIS relay child");
    }
    expect(relay.name).toBe("ais-relay");
    expect(relay.env.PORT).toBe("3004");
    expect(relay.command).toBe("go");
    expect(relay.args).toEqual(["run", "./cmd/ais-relay"]);
  });
});

describe("local dev launcher lifecycle", () => {
  it("returns the first failing child exit code", async () => {
    const code = await runChildren([
      {
        name: "exit-7",
        cwd: repoRoot,
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        env: environmentWithStrings(),
      },
    ]);

    expect(code).toBe(7);
  });

  it("forwards SIGTERM to the child process group and reports 143", async () => {
    const marker = path.join(
      os.tmpdir(),
      `newwei-dev-launcher-${process.pid}-${Date.now()}.txt`,
    );
    const script = [
      'process.on("SIGTERM", () => {',
      '  require("node:fs").writeFileSync(process.env.DEV_TEST_MARKER, "ok");',
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const signalSource = new EventEmitter();
    const env = environmentWithStrings();
    env.DEV_TEST_MARKER = marker;

    const running = runChildren(
      [
        {
          name: "wait-for-signal",
          cwd: repoRoot,
          command: process.execPath,
          args: ["-e", script],
          env,
        },
      ],
      { signalSource, killTimeoutMs: 3_000 },
    );

    setTimeout(() => signalSource.emit("SIGTERM"), 250);
    const code = await running;

    expect(code).toBe(143);
    try {
      expect(readFileSync(marker, "utf8")).toBe("ok");
    } finally {
      unlinkSync(marker);
    }
  });
});
