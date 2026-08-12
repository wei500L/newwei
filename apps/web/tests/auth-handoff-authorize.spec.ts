import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

const nextAuthCapture: { config?: unknown } = {};

vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    nextAuthCapture.config = config;
    return {
      handlers: {},
      auth: {},
      signIn: {},
      signOut: {},
    };
  },
}));

vi.mock("next-auth/jwt", () => ({}));

vi.mock("../lib/env.server", () => ({
  serverEnv: {
    NEXTAUTH_SECRET: "test-secret",
    NEXTAUTH_URL: "http://localhost:3000",
    apiBaseUrl: "http://localhost:4000/api",
  },
}));

vi.mock("../lib/server-logger", () => ({
  logServerError: vi.fn(),
}));

vi.mock("../lib/trace", () => ({
  createTraceHeaders: (headers: Record<string, string>) => headers,
}));

async function loadAuthorize() {
  await import("../lib/auth");
  const config = nextAuthCapture.config as {
    providers?: Array<{
      id?: string;
      options?: {
        id?: string;
        authorize: (credentials: Record<string, unknown>) => Promise<unknown>;
      };
    }>;
  };
  const provider = config.providers?.find(
    (entry) => entry.options?.id === "handoff",
  );
  return provider?.options?.authorize;
}

describe("auth handoff provider authorize (B11)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    nextAuthCapture.config = undefined;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("validates the bearer token against /auth/me instead of trusting userJson", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "user-1",
          email: "admin@example.com",
          firstName: "Admin",
          lastName: "User",
          orgId: "org-1",
          permissions: ["items.read"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const authorize = await loadAuthorize();
    const result = (await authorize?.({
      accessToken: "token-abc",
      refreshToken: "refresh-abc",
      expiresIn: "900",
      userJson: JSON.stringify({
        id: "attacker",
        email: "attacker@evil.example",
        firstName: "Attacker",
        lastName: "X",
        orgId: "org-9",
        permissions: ["admin"],
      }),
    })) as { user: { id: string; email: string } };

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/auth/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-abc",
        }),
      }),
    );
    // Identity comes from the backend response, not the forged userJson.
    expect(result.user.id).toBe("user-1");
    expect(result.user.email).toBe("admin@example.com");
  });

  it("rejects sign-in when the access token fails /auth/me validation", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const authorize = await loadAuthorize();
    const result = await authorize?.({
      accessToken: "bad-token",
      refreshToken: "refresh-abc",
      expiresIn: "900",
      userJson: JSON.stringify({
        id: "attacker",
        email: "attacker@evil.example",
        firstName: "Attacker",
        lastName: "X",
        orgId: "org-9",
        permissions: ["admin"],
      }),
    });

    expect(result).toBeNull();
  });

  it("rejects when required token fields are missing", async () => {
    const authorize = await loadAuthorize();
    const result = await authorize?.({ userJson: '{"id":"x"}' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
