import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FilterBar } from "@/components/filter-bar";
import { renderWithProviders } from "@/test/render";

describe("FilterBar", () => {
  it("renders each item's label and exposes a group landmark", () => {
    renderWithProviders(
      <FilterBar>
        <FilterBar.Item label="状态">
          <input aria-label="状态" />
        </FilterBar.Item>
        <FilterBar.Item label="来源">
          <input aria-label="来源" />
        </FilterBar.Item>
      </FilterBar>,
    );
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(screen.getByText("状态")).toBeInTheDocument();
    expect(screen.getByText("来源")).toBeInTheDocument();
  });

  it("renders the trailing actions", () => {
    renderWithProviders(
      <FilterBar actions={<button>重置</button>}>
        <FilterBar.Item label="状态">
          <input aria-label="状态" />
        </FilterBar.Item>
      </FilterBar>,
    );
    expect(screen.getByRole("button", { name: "重置" })).toBeInTheDocument();
  });
});
