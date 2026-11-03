import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import {
  CockpitInstrumentsView,
  COCKPIT_BRIEF_TAB_ATTR,
  COCKPIT_DOM_IDS,
} from "./cockpit-instruments";

const instruments = {
  callsign: "UAL123",
  meta: { text: "LIVE TRACK · COURSE ALIGNED", emergency: false },
  speed: "450",
  altitude: "35000",
  heading: "270",
};

describe("CockpitInstrumentsView", () => {
  it("显示速度、高度与呼号", () => {
    const { container } = renderWithProviders(
      <CockpitInstrumentsView
        instruments={instruments}
        presence={{ active: true }}
        vision={{ mode: "nvg", label: "NVG", name: "Night vision" }}
      />,
    );

    expect(container.querySelector("#cockpit-speed-value")?.textContent).toBe(
      "450",
    );
    expect(
      container.querySelector("#cockpit-altitude-value")?.textContent,
    ).toBe("35000");
    expect(container.querySelector("#cockpit-callsign")?.textContent).toBe(
      "UAL123",
    );
  });

  it("紧急状态给机型元信息加玫红", () => {
    const { container } = renderWithProviders(
      <CockpitInstrumentsView
        instruments={{ ...instruments, meta: { text: "EMERGENCY", emergency: true } }}
        presence={{ active: true }}
        vision={null}
      />,
    );
    expect(
      container.querySelector("#cockpit-aircraft-meta")?.className,
    ).toContain("text-rose-400");
  });

  it("骨架包含 GEV 需要的全部 id（防回归）", () => {
    const { container } = renderWithProviders(
      <CockpitInstrumentsView
        instruments={instruments}
        presence={{ active: true }}
        vision={{ mode: "optical", label: "NORMAL" }}
      />,
    );

    for (const id of COCKPIT_DOM_IDS) {
      expect(
        container.querySelector(`#${id}`),
        `missing cockpit DOM id: #${id}`,
      ).not.toBeNull();
    }
    // `[data-cockpit-brief-index]` 选择器（简报页签）。
    expect(
      container.querySelector(`[${COCKPIT_BRIEF_TAB_ATTR}]`),
    ).not.toBeNull();
  });

  it("非驾驶舱时 #cockpit-hud 隐藏但元素仍在", () => {
    const { container } = renderWithProviders(
      <CockpitInstrumentsView
        instruments={null}
        presence={{ active: false }}
        vision={null}
      />,
    );
    const hud = container.querySelector("#cockpit-hud") as HTMLElement | null;
    expect(hud).not.toBeNull();
    expect(hud?.hidden).toBe(true);
  });
});
