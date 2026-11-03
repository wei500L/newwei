import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { EventGlobeButton } from "./event-globe-button";

describe("EventGlobeButton", () => {
  it("有坐标时渲染「在 3D 地球查看」按钮并带上坐标链接", () => {
    renderWithProviders(
      <EventGlobeButton lat={35.5} lon={105.2} label="Strait incident" eventId="evt-1" />,
    );
    const link = screen.getByRole("link", {
      name: /在 3D 地球查看|View on 3D globe/,
    });
    expect(link).toHaveAttribute(
      "href",
      "/globe?lat=35.5&lon=105.2&label=Strait+incident&focus=newwei-events%3Aevt-1",
    );
  });

  it("没有坐标时不渲染", () => {
    const { container } = renderWithProviders(
      <EventGlobeButton lat={null} lon={null} label="No location" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("坐标越界时不渲染", () => {
    const { container } = renderWithProviders(
      <EventGlobeButton lat={91} lon={105} label="Bad" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
