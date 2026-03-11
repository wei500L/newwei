import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();

vi.mock("next-auth/react", () => ({
  getSession: getSessionMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe("browser auth session cache", () => {
  beforeEach(async () => {
    vi.stubGlobal("window", {});
    getSessionMock.mockReset();

    const { invalidateBrowserAuthSessionCache } = await import("../lib/browser-auth-session");
    invalidateBrowserAuthSessionCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    getSessionMock.mockReset();

    const { invalidateBrowserAuthSessionCache } = await import("../lib/browser-auth-session");
    invalidateBrowserAuthSessionCache();
  });

  it("does not let a stale in-flight fetch overwrite an explicit session update", async () => {
    const {
      getCachedBrowserAuthSession,
      setBrowserAuthSession,
    } = await import("../lib/browser-auth-session");
    const staleSession = createDeferred<Record<string, unknown> | null>();

    getSessionMock.mockReturnValueOnce(staleSession.promise);
    const staleResultPromise = getCachedBrowserAuthSession();

    setBrowserAuthSession({ accessToken: "switched-token", orgId: "org-b" });
    staleSession.resolve({ accessToken: "stale-token", orgId: "org-a" });

    expect(await staleResultPromise).toEqual({ accessToken: "stale-token", orgId: "org-a" });
    expect(await getCachedBrowserAuthSession()).toEqual({
      accessToken: "switched-token",
      orgId: "org-b",
    });
  });
});
