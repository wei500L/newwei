import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { EventGlobeButton } from "./event-globe-button";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
}));

describe("EventGlobeButton", () => {
  beforeEach(() => {
    mocks.push.mockClear();
  });

  it("有坐标时点击调用 router.push，链接只带坐标与标题、不含 focus", () => {
    renderWithProviders(
      <EventGlobeButton lat={35.5} lon={105.2} label="Strait incident" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /在 3D 地球查看|View on 3D globe/ }),
    );
    expect(mocks.push).toHaveBeenCalledTimes(1);
    const href = mocks.push.mock.calls[0]![0] as string;
    expect(href).toBe("/globe?lat=35.5&lon=105.2&label=Strait+incident");
    expect(href).not.toContain("focus=");
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
