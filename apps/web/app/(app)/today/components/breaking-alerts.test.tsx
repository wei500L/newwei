import { gql } from "@apollo/client";
import { MockedProvider } from "@apollo/client/testing";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { BreakingAlerts } from "./breaking-alerts";

const BREAKING_ALERTS_QUERY = gql`
  query BreakingAlerts($windowDays: Int, $status: NewsEventStatus) {
    newsEvents(windowDays: $windowDays, status: $status) {
      id
      title
      status
      lastAt
      itemCount
      breaking
      heatScore
    }
  }
`;

function buildAlert(index: number) {
  return {
    __typename: "NewsEvent",
    id: `alert-${index}`,
    title: `Breaking alert ${index}`,
    status: "active",
    lastAt: "2026-11-02T08:00:00.000Z",
    itemCount: 8,
    breaking: true,
    heatScore: 9.5,
  };
}

function buildMock(alerts: ReturnType<typeof buildAlert>[]) {
  return [
    {
      request: {
        query: BREAKING_ALERTS_QUERY,
        variables: { windowDays: 1, status: "active" },
      },
      result: { data: { newsEvents: alerts } },
    },
  ];
}

function renderBreaking(mocks: ReturnType<typeof buildMock>) {
  return renderWithProviders(
    <MockedProvider mocks={mocks}>
      <BreakingAlerts />
    </MockedProvider>,
  );
}

describe("BreakingAlerts", () => {
  it("shows only the first three alerts and the remaining count by default", async () => {
    renderBreaking(buildMock([1, 2, 3, 4, 5].map(buildAlert)));

    expect(await screen.findByText("Breaking alert 1")).toBeInTheDocument();
    expect(screen.getByText("Breaking alert 2")).toBeInTheDocument();
    expect(screen.getByText("Breaking alert 3")).toBeInTheDocument();
    expect(screen.queryByText("Breaking alert 4")).not.toBeInTheDocument();
    expect(screen.queryByText("Breaking alert 5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 more" })).toBeInTheDocument();
  });

  it("reveals all alerts after expanding", async () => {
    const user = userEvent.setup();
    renderBreaking(buildMock([1, 2, 3, 4, 5].map(buildAlert)));

    await user.click(await screen.findByRole("button", { name: "2 more" }));

    expect(screen.getByText("Breaking alert 4")).toBeInTheDocument();
    expect(screen.getByText("Breaking alert 5")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "2 more" })).not.toBeInTheDocument(),
    );
  });

  it("renders nothing when there are no breaking alerts", async () => {
    const { container } = renderBreaking(buildMock([]));

    await waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(screen.queryByText("Breaking")).not.toBeInTheDocument();
  });
});
