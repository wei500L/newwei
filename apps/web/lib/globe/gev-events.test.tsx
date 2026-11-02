import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  useGevSelection,
  useGevStyle,
  useGevWindowEvent,
  useMapStack,
} from "./gev-events";

function dispatch(type: string, detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  });
}

function SelectionProbe() {
  const selection = useGevSelection();
  if (!selection) return <div data-testid="selection">none</div>;
  const record = selection.record;
  return (
    <div data-testid="selection">
      {selection.source}:{record.label ?? record.name ?? record.id}
    </div>
  );
}

function EventProbe() {
  const detail = useGevWindowEvent<{ value: string }>("gev:test-event");
  return <div data-testid="event">{detail?.value ?? "none"}</div>;
}

function MapStackProbe() {
  const state = useMapStack<{ activeId: string }>();
  return <div data-testid="map-stack">{state?.activeId ?? "none"}</div>;
}

function StyleProbe() {
  const style = useGevStyle<{ style: string }>();
  return <div data-testid="style">{style?.style ?? "none"}</div>;
}

describe("gev events hooks", () => {
  it("useGevWindowEvent 返回最近一次的 detail", () => {
    render(<EventProbe />);
    expect(screen.getByTestId("event")).toHaveTextContent("none");
    dispatch("gev:test-event", { value: "alpha" });
    expect(screen.getByTestId("event")).toHaveTextContent("alpha");
    dispatch("gev:test-event", { value: "beta" });
    expect(screen.getByTestId("event")).toHaveTextContent("beta");
  });

  it("useGevSelection 合并实体选择与跟踪型选择，并在清除后回到 null", () => {
    render(<SelectionProbe />);
    expect(screen.getByTestId("selection")).toHaveTextContent("none");

    dispatch("gev:entity-selected", {
      id: "entity-1",
      layerId: "local-adsb",
      label: "Entity One",
    });
    expect(screen.getByTestId("selection")).toHaveTextContent(
      "entity:Entity One",
    );

    dispatch("gev:awareness-subject-selected", {
      id: "abc123",
      layerId: "flights",
      label: "UAL123",
    });
    expect(screen.getByTestId("selection")).toHaveTextContent("tracked:UAL123");

    dispatch("gev:entity-selection-cleared", { layerId: "flights" });
    expect(screen.getByTestId("selection")).toHaveTextContent("none");
  });

  it("useGevSelection 只在同一图层的清除事件时清除选择", () => {
    render(<SelectionProbe />);
    dispatch("gev:awareness-subject-selected", {
      id: "abc123",
      layerId: "flights",
      label: "UAL123",
    });
    // 不同图层的清除不应清掉当前选择。
    dispatch("gev:entity-selection-cleared", { layerId: "local-adsb" });
    expect(screen.getByTestId("selection")).toHaveTextContent("tracked:UAL123");
    dispatch("gev:entity-selection-cleared", { layerId: "flights" });
    expect(screen.getByTestId("selection")).toHaveTextContent("none");
  });

  it("useMapStack 返回地图栈 detail", () => {
    render(<MapStackProbe />);
    expect(screen.getByTestId("map-stack")).toHaveTextContent("none");
    dispatch("gev:map-stack-changed", { activeId: "esri-imagery" });
    expect(screen.getByTestId("map-stack")).toHaveTextContent("esri-imagery");
  });

  it("useGevStyle 合并 style-change 与 vision-change", () => {
    render(<StyleProbe />);
    expect(screen.getByTestId("style")).toHaveTextContent("none");
    dispatch("gev:style-change", { style: "nvg" });
    expect(screen.getByTestId("style")).toHaveTextContent("nvg");
    dispatch("gev:vision-change", { style: "flir" });
    expect(screen.getByTestId("style")).toHaveTextContent("flir");
  });
});
