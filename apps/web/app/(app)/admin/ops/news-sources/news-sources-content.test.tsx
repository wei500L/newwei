import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const socketMockState = vi.hoisted(() => ({
  permissions: [] as string[],
  ioCalls: [] as {
    namespace: string;
    options?: Record<string, unknown>;
  }[],
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      accessToken: "token",
      permissions: socketMockState.permissions,
      user: { id: "user-1", permissions: socketMockState.permissions },
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("socket.io-client", () => ({
  io: (namespace: string, options?: Record<string, unknown>) => {
    socketMockState.ioCalls.push({ namespace, options });
    return {
      on: vi.fn(),
      off: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

vi.mock("@/app/(app)/crawl/components/CreateCrawlTaskDrawer", () => ({
  CreateCrawlTaskDrawer: () => null,
}));

vi.mock("@/app/(app)/crawl/components/Crawl4aiHealthCard", () => ({
  Crawl4aiHealthCard: () => null,
}));

describe("NewsSourcesContent permissions", () => {
  beforeEach(() => {
    socketMockState.permissions.length = 0;
    socketMockState.ioCalls.length = 0;
  });

  it("hides management UI when the session lacks crawl.read", async () => {
    const { NewsSourcesContent } = await import("./news-sources-content");
    renderWithProviders(<NewsSourcesContent />);

    expect(
      await screen.findByText("Admin only", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Admin only description"),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Search by name or URL"),
    ).not.toBeInTheDocument();
  });

  it("connects to the {apiRoot}/ops namespace with the configured Engine.IO path", async () => {
    socketMockState.permissions.push("crawl.read");
    const { NewsSourcesContent } = await import("./news-sources-content");
    renderWithProviders(<NewsSourcesContent />);

    await waitFor(() => {
      expect(socketMockState.ioCalls).toHaveLength(1);
    });
    expect(socketMockState.ioCalls[0]!).toMatchObject({
      namespace: "http://localhost:4000/ops",
      options: { path: "/socket.io" },
    });
  });
});
