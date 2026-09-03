import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { NotificationCenter } from "./notification-center";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { permissions: [] },
    status: "authenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/graphql/generated", () => ({
  NotificationType: {
    AlertTriggered: "alert_triggered",
    AnalysisCompleted: "analysis_completed",
    AnalysisFailed: "analysis_failed",
    CrawlCompleted: "crawl_completed",
    CrawlFailed: "crawl_failed",
    OrgInvite: "org_invite",
    System: "system",
  },
  useNotificationsQuery: () => ({
    data: undefined,
    loading: true,
    refetch: vi.fn(),
  }),
  useUnreadNotificationCountQuery: () => ({
    data: undefined,
    refetch: vi.fn(),
  }),
  useMarkNotificationReadMutation: () => [vi.fn()],
  useMarkAllNotificationsReadMutation: () => [vi.fn()],
}));

vi.mock("./use-notification-stream", () => ({
  useNotificationStream: () => ({
    connected: false,
    connectionError: undefined,
  }),
}));

describe("NotificationCenter（触发按钮触控尺寸契约）", () => {
  it("默认 32px 紧凑尺寸：不传 size 的消费方行为不变", () => {
    renderWithProviders(<NotificationCenter />);

    const trigger = screen.getByRole("button", { name: "Notifications" });
    expect(trigger).toHaveClass("h-8");
    expect(trigger).toHaveClass("w-8");
    expect(trigger).not.toHaveClass("!h-11");
  });

  it("size=large：命中区放大到 44px，aria-label/Badge/Popover 结构保留", () => {
    renderWithProviders(<NotificationCenter size="large" />);

    const trigger = screen.getByRole("button", { name: "Notifications" });
    expect(trigger).toHaveClass("!h-11");
    expect(trigger).toHaveClass("!w-11");
    expect(trigger).toHaveAttribute("aria-label", "Notifications");
  });
});
