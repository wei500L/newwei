import { screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, renderWithProviders } from "@/test/render";

import { ItemsView } from "./items-view";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { accessToken: "test-token", permissions: [], user: { permissions: [] } },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/items",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@apollo/client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useQuery: () => ({
      data: undefined,
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    }),
    useMutation: () => [vi.fn(), { loading: false }],
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useWindowVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    measureElement: () => undefined,
    scrollMargin: 0,
  }),
}));

vi.mock("@/hooks/use-chart-theme", () => ({
  useChartTheme: () => ({
    echartsTheme: "smart-light",
    colors: {
      primary: "#1f3b7b",
      bullish: "#1b9e77",
      bearish: "#d95f02",
      destructive: "#dc2626",
      accent: "#d97706",
      background: "transparent",
      foreground: "#475569",
      border: "#e2e8f0",
      grid: "rgba(15, 23, 42, 0.08)",
      tooltipBg: "#0f172a",
      tooltipText: "#f8fafc",
      secondary: "#e2e8f0",
    },
    fontFamily: "var(--font-mono), monospace",
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("ItemsView analysis toolbar", () => {
  it("does not render the analysis toolbar when showAnalysisToolbar is false", () => {
    renderWithProviders(<ItemsView showAnalysisToolbar={false} />);

    expect(screen.queryByText("分析工作台")).toBeNull();
  });

  it("renders the analysis toolbar by default", () => {
    renderWithProviders(<ItemsView />);

    expect(screen.getByText("分析工作台")).toBeInTheDocument();
  });
});
