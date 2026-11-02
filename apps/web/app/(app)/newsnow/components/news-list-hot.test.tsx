import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { NewsListHot } from "./news-list-hot";

/**
 * FE-UI 批9D：热榜列表的 hover 操作行改为绝对定位 + 键盘可达。
 * 用 Tab 聚焦后，操作按钮必须真实存在并可点击（触发对应回调）。
 */
describe("NewsListHot 操作行键盘可达", () => {
  it("Tab 聚焦后可访问并点击事件按钮", async () => {
    const user = userEvent.setup();
    const onOpenEvent = vi.fn();

    renderWithProviders(
      <NewsListHot
        items={[
          {
            id: "item-1",
            title: "示例热榜条目",
            url: "https://example.com/news/item-1",
          },
        ]}
        onOpenEvent={onOpenEvent}
        actionAvailabilityByItemId={{
          "item-1": { hasEvent: true, hasItem: true },
        }}
      />,
    );

    let eventButton: HTMLElement | null = null;
    for (let index = 0; index < 8; index += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      if (
        active?.tagName === "BUTTON" &&
        active.textContent?.includes("Event")
      ) {
        eventButton = active;
        break;
      }
    }

    expect(eventButton).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Event" }),
    ).toBeInTheDocument();

    await user.click(eventButton as HTMLElement);
    expect(onOpenEvent).toHaveBeenCalledTimes(1);
  });
});
