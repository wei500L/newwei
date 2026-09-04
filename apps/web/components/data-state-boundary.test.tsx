import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DataStateBoundary } from "@/components/data-state-boundary";
import { renderWithProviders } from "@/test/render";

/**
 * DataStateBoundary 行为测试（FE-批3）。
 *
 * 状态分派的用户可见断言；错误分类细节由 request-error-empty-state 的
 * 既有行为承载（kind=permission → 权限空态），此处只验证分派正确。
 */

function renderBoundary(props: Parameters<typeof DataStateBoundary>[0]) {
  return renderWithProviders(
    <DataStateBoundary {...props}>data content</DataStateBoundary>,
  );
}

describe("DataStateBoundary 状态分派", () => {
  it("initialLoading：role=status + 可访问加载名称，不渲染 children", () => {
    renderBoundary({ state: { kind: "initialLoading" } });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "Loading...");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("permissionDenied：权限空态文案（默认 i18n key）", () => {
    renderBoundary({ state: { kind: "permissionDenied" } });
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You don't have permission to view this data. Contact an administrator if you need access.",
      ),
    ).toBeInTheDocument();
  });

  it("permissionDenied：文案可由调用方提供", () => {
    renderBoundary({
      state: { kind: "permissionDenied" },
      permissionTitle: "Custom title",
      permissionDescription: "Custom description",
    });
    expect(screen.getByText("Custom title")).toBeInTheDocument();
    expect(screen.getByText("Custom description")).toBeInTheDocument();
  });

  it("blockingError：默认空态保留 retry；点击触发 onRetry", async () => {
    const onRetry = vi.fn();
    renderBoundary({
      state: { kind: "blockingError", error: new Error("boom") },
      onRetry,
    });

    expect(screen.getByText("Request failed")).toBeInTheDocument();
    expect(screen.queryByText("data content")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("blockingError：permission 类错误不显示 retry（沿用现有语义）", () => {
    const permissionError = {
      graphQLErrors: [{ extensions: { code: "FORBIDDEN" } }],
    };
    renderBoundary({
      state: { kind: "blockingError", error: permissionError },
      onRetry: () => undefined,
    });

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("empty：空态文案（默认 i18n key，可覆盖）", () => {
    const { rerender } = renderBoundary({ state: { kind: "empty" } });
    expect(screen.getByText("No data")).toBeInTheDocument();

    rerender(
      <DataStateBoundary
        state={{ kind: "empty" }}
        emptyDescription="Nothing here yet"
      />,
    );
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("ready：渲染 children，无状态装饰", () => {
    renderBoundary({ state: { kind: "ready" } });
    expect(screen.getByText("data content")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshing：保留 children 并标记 aria-busy，不显示 Spin 整页替换", () => {
    renderBoundary({ state: { kind: "refreshing" } });
    expect(screen.getByText("data content")).toBeInTheDocument();
    const busyHost = screen.getByText("data content").closest('[aria-busy="true"]');
    expect(busyHost).not.toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("nonBlockingError：保留 children + 非阻断横幅（alert role）+ 重试", async () => {
    const onRetry = vi.fn();
    renderBoundary({
      state: { kind: "nonBlockingError", error: new Error("refresh failed") },
      onRetry,
    });

    // children 保留
    expect(screen.getByText("data content")).toBeInTheDocument();
    // 非阻断横幅
    const banner = screen.getByRole("alert");
    expect(banner).toBeInTheDocument();
    expect(screen.getByText("Showing cached data.")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Retry fetch"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("loadingLabel 可覆盖初始加载的可访问名称", () => {
    renderBoundary({
      state: { kind: "initialLoading" },
      loadingLabel: "正在加载告警",
    });
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "正在加载告警");
  });
});
