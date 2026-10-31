import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseEnvText } from "../../../infra/scripts/src/dev-config";

/**
 * Behavioural cover for the web-side connection defaults.
 *
 * The repository default moved to the Go chain, so the browser has to derive
 * three things consistently from the environment: the API base, the GraphQL
 * endpoint and both Engine.IO transport paths. Asserting the resolved URLs (and
 * the path actually handed to socket.io-client) is what catches a mismatch
 * between the Go switches, the build args and the client code; a source-text
 * check would not.
 */

const GO_API_BASE = "http://localhost:4020";

async function loadEnvModule(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      vi.stubEnv(key, undefined as unknown as string);
    } else {
      vi.stubEnv(key, value);
    }
  }
  return import("./env");
}

describe("web connection defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("derives the API, GraphQL and both transport paths from a bare API base", async () => {
    const { env } = await loadEnvModule({
      NEXT_PUBLIC_API_BASE_URL: GO_API_BASE,
      // Left unset so the schema defaults apply, which is what a default
      // deployment relies on: the image is built without these build args and
      // the client must fall back to the Go transport paths.
      NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH: undefined,
      NEXT_PUBLIC_REALTIME_SOCKET_PATH: undefined,
    });

    expect(env.apiBaseUrl).toBe(`${GO_API_BASE}/api`);
    expect(env.apiRoot).toBe(GO_API_BASE);
    expect(env.graphqlUrl).toBe(`${GO_API_BASE}/graphql`);
    expect(env.NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH).toBe(
      "/socket.io-notifications",
    );
    expect(env.NEXT_PUBLIC_REALTIME_SOCKET_PATH).toBe("/socket.io-realtime");
  });

  it("keeps an API base that already ends in /api", async () => {
    const { env } = await loadEnvModule({
      NEXT_PUBLIC_API_BASE_URL: `${GO_API_BASE}/api`,
    });

    expect(env.apiBaseUrl).toBe(`${GO_API_BASE}/api`);
    expect(env.apiRoot).toBe(GO_API_BASE);
    expect(env.graphqlUrl).toBe(`${GO_API_BASE}/graphql`);
  });

  it("honours explicitly configured legacy transport paths", async () => {
    const { env } = await loadEnvModule({
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:4000/api",
      NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH: "/socket.io",
      NEXT_PUBLIC_REALTIME_SOCKET_PATH: "/socket.io",
    });

    expect(env.NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH).toBe("/socket.io");
    expect(env.NEXT_PUBLIC_REALTIME_SOCKET_PATH).toBe("/socket.io");
  });

  it("uses the shipped root .env.example values end to end", async () => {
    const example = parseEnvText(
      readFileSync(path.resolve(process.cwd(), "../../.env.example"), "utf8"),
    );
    const { env } = await loadEnvModule({
      NEXT_PUBLIC_API_BASE_URL: example.NEXT_PUBLIC_API_BASE_URL,
      NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH:
        example.NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH,
      NEXT_PUBLIC_REALTIME_SOCKET_PATH:
        example.NEXT_PUBLIC_REALTIME_SOCKET_PATH,
    });

    expect(env.apiBaseUrl).toBe("http://localhost:4020/api");
    expect(env.apiRoot).toBe("http://localhost:4020");
    expect(env.graphqlUrl).toBe("http://localhost:4020/graphql");
    expect(env.NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH).toBe(
      "/socket.io-notifications",
    );
    expect(env.NEXT_PUBLIC_REALTIME_SOCKET_PATH).toBe("/socket.io-realtime");
  });
});
