import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { NewsHubPillars } from "./news-hub-pillars";

describe("NewsHubPillars", () => {
  it("renders three pillar headings that link to their routes", () => {
    renderWithProviders(<NewsHubPillars />);

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(3);

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/newsnow/hottest", "/items", "/events"]);
  });
});
