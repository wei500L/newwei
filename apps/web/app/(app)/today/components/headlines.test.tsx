import { gql } from "@apollo/client";
import { MockedProvider } from "@apollo/client/testing";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import dayjs from "@/lib/dayjs";
import { renderWithProviders } from "@/test/render";

import { Headlines } from "./headlines";

// ChartEmptyState 消费 useChartTheme（依赖 ThemeProvider 的 useTheme）；
// jsdom 无完整 token 上下文，走确定性替身（与 data-state-boundary 测试同模式）。
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

const HEADLINES_QUERY = gql`
  query Headlines($first: Int!, $filters: ItemsFiltersInput, $orderBy: ItemsOrderBy) {
    items(first: $first, filters: $filters, orderBy: $orderBy) {
      edges {
        node {
          id
          title
          publishedAt
          rawPreview {
            url
            sourceName
            thumbnail
          }
          processedPreview {
            summary
            qualityScore
          }
        }
      }
    }
  }
`;

function buildMock(
  edges: { node: Record<string, unknown> }[],
) {
  return [
    {
      request: {
        query: HEADLINES_QUERY,
        variables: {
          first: 4,
          filters: {
            dateRange: {
              start: dayjs().startOf("day").toISOString(),
              end: dayjs().endOf("day").toISOString(),
            },
          },
          orderBy: "PUBLISHED_DESC",
        },
      },
      result: { data: { items: { edges } } },
    },
  ];
}

describe("Headlines", () => {
  it("renders the empty state when there are no headlines", async () => {
    renderWithProviders(
      <MockedProvider mocks={buildMock([])}>
        <Headlines />
      </MockedProvider>,
    );

    expect(await screen.findByText("No headlines yet today.")).toBeInTheDocument();
  });
});
