import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      accessToken: "token",
      permissions: [],
      user: { id: "user-1", permissions: [] },
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("socket.io-client", () => ({
  io: () => ({
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  }),
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
});
