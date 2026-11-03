import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { IntelHud, type HudView } from "./intel-hud";

const view: HudView = {
  active: true,
  classification: "TOP SECRET // SI-TK // NOFORN",
  system: "KH11-4012  OPS-4133",
  timestamp: "2026-11-03 12:00:00Z",
  mode: "NVG",
  latlon: `31°13'49.00"N 121°28'25.00"E`,
  mgrs: "MGRS: 51RUQ 1234 5678",
  alt: "ALT: 1200m   SUN: 12.3° EL",
  gsd: "GSD: 1.20m  NIIRS: 5.2",
  ona: "ONA: 12.3°",
};

describe("IntelHud", () => {
  it("渲染四个角的内容", () => {
    renderWithProviders(<IntelHud view={view} />);

    // 左上：classification + system
    expect(screen.getByText(view.classification!)).toBeInTheDocument();
    expect(screen.getByText(/KH11-4012\s+OPS-4133/)).toBeInTheDocument();
    // 右上：timestamp + mode
    expect(screen.getByText(view.timestamp!)).toBeInTheDocument();
    expect(screen.getByText(view.mode!)).toBeInTheDocument();
    // 左下：latlon + mgrs
    expect(screen.getByText(view.latlon!)).toBeInTheDocument();
    expect(screen.getByText(view.mgrs!)).toBeInTheDocument();
    // 右下：alt + gsd + ona
    expect(screen.getByText(/ALT: 1200m/)).toBeInTheDocument();
    expect(screen.getByText(/GSD: 1\.20m/)).toBeInTheDocument();
    expect(screen.getByText(view.ona!)).toBeInTheDocument();
  });

  it("hud 为 null 时不渲染", () => {
    const { container } = renderWithProviders(<IntelHud view={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("可见标记为假时不渲染", () => {
    const { container } = renderWithProviders(
      <IntelHud view={{ ...view, active: false }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("纯净视图（V）时不渲染", () => {
    const { container } = renderWithProviders(
      <IntelHud view={view} cleanView />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("空字段不产生多余行", () => {
    renderWithProviders(<IntelHud view={{ active: true, mode: "NORMAL" }} />);
    expect(screen.getByText("NORMAL")).toBeInTheDocument();
  });
});
