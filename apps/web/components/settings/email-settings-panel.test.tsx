import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { accessToken: "token", user: { id: "user-1" } },
  }),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    post: (...args: unknown[]) => post(...args),
  }),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

describe("EmailSettingsPanel", () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    post.mockReset();
    get.mockResolvedValue({
      data: {
        smtp: {
          host: "smtp.example.com",
          port: 465,
          secure: true,
          user: "alerts@example.com",
          from: "Wei <alerts@example.com>",
          pool: true,
          maxConnections: 5,
          maxMessages: 100,
          rateDeltaMs: 1000,
          rateLimit: 10,
          connectionTimeoutMs: 10000,
          greetingTimeoutMs: 10000,
          socketTimeoutMs: 10000,
          tlsRejectUnauthorized: true,
        },
        verify: { ok: true, checkedAt: "2026-08-15T00:00:00.000Z", error: null },
        authCode: { ttlSeconds: 300, cooldownSeconds: 90, maxAttempts: 3 },
      },
    });
    put.mockResolvedValue({
      data: { ttlSeconds: 300, cooldownSeconds: 90, maxAttempts: 3 },
    });
  });

  it("loads settings and saves auth-code configuration", async () => {
    const user = userEvent.setup();
    const { EmailSettingsPanel } = await import("./email-settings-panel");
    renderWithProviders(<EmailSettingsPanel />);

    expect(await screen.findByText("smtp.example.com")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(put).toHaveBeenCalledWith("system-settings/email/auth-code", {
        ttlSeconds: 300,
        cooldownSeconds: 90,
        maxAttempts: 3,
      });
    });
  });
});
