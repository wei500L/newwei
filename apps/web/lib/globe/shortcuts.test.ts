import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { bindGlobeShortcuts, type GlobeShortcutActions } from "./shortcuts";

function createActions() {
  return {
    setStyle: vi.fn(),
    dismissSearch: vi.fn(),
    toggleHud: vi.fn(),
    toggleOrbit: vi.fn(),
    toggleCleanView: vi.fn(),
    toggleLayers: vi.fn(),
    cycleDetection: vi.fn(),
    toggleCctv: vi.fn(),
  } satisfies Record<keyof GlobeShortcutActions, unknown>;
}

describe("bindGlobeShortcuts", () => {
  it("数字键 1–6 切换对应风格", () => {
    const actions = createActions();
    const unbind = bindGlobeShortcuts(document, actions);
    try {
      fireEvent.keyDown(document, { key: "3" });
      expect(actions.setStyle).toHaveBeenCalledWith("surveillance");
      fireEvent.keyDown(document, { key: "4" });
      expect(actions.setStyle).toHaveBeenCalledWith("thermal");
      fireEvent.keyDown(document, { key: "1" });
      expect(actions.setStyle).toHaveBeenCalledWith("normal");
    } finally {
      unbind();
    }
  });

  it("字母键派发对应动作", () => {
    const actions = createActions();
    const unbind = bindGlobeShortcuts(document, actions);
    try {
      fireEvent.keyDown(document, { key: "d" });
      expect(actions.cycleDetection).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: "o" });
      expect(actions.toggleOrbit).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: "f" });
      expect(actions.toggleLayers).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: "v" });
      expect(actions.toggleCleanView).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: "h" });
      expect(actions.toggleHud).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: "c" });
      expect(actions.toggleCctv).toHaveBeenCalledTimes(1);
    } finally {
      unbind();
    }
  });

  it("焦点在输入框时不触发，Esc 例外", () => {
    const actions = createActions();
    const unbind = bindGlobeShortcuts(document, actions);
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      input.focus();
      fireEvent.keyDown(input, { key: "3" });
      expect(actions.setStyle).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(actions.dismissSearch).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
      unbind();
    }
  });

  it("按下 Ctrl / Meta / Alt 时不触发", () => {
    const actions = createActions();
    const unbind = bindGlobeShortcuts(document, actions);
    try {
      fireEvent.keyDown(document, { key: "3", ctrlKey: true });
      fireEvent.keyDown(document, { key: "3", metaKey: true });
      fireEvent.keyDown(document, { key: "3", altKey: true });
      expect(actions.setStyle).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });

  it("解绑后不再响应", () => {
    const actions = createActions();
    const unbind = bindGlobeShortcuts(document, actions);
    unbind();
    fireEvent.keyDown(document, { key: "3" });
    expect(actions.setStyle).not.toHaveBeenCalled();
  });
});
