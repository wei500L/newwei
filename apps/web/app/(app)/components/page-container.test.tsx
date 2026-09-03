import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageContainer } from "./page-container";

// App Shell 第一批原语的行为测试：宽度档位与边距语义收敛（静态渲染断言，
// 不依赖主题/i18n provider——PageContainer 是纯布局组件）。
describe("PageContainer", () => {
  it("applies the default width (1440) and default padding", () => {
    const { container } = render(
      <PageContainer>
        <span>content</span>
      </PageContainer>,
    );
    expect(container.firstChild).toHaveClass("max-w-[1440px]");
    expect(container.firstChild).toHaveClass("p-4");
    expect(container.firstChild).toHaveClass("mx-auto");
  });

  it.each([
    ["wide", "max-w-[1920px]"],
    ["wide-board", "max-w-[1760px]"],
    ["article", "max-w-[1200px]"],
    ["full", "max-w-none"],
  ] as const)("applies the %s width tier", (width, expectedClass) => {
    const { container } = render(<PageContainer contentWidth={width}>x</PageContainer>);
    expect(container.firstChild).toHaveClass(expectedClass);
  });

  it("padding=none omits the page padding (edge-to-edge pages self-manage)", () => {
    const { container } = render(<PageContainer padding="none">x</PageContainer>);
    expect(container.firstChild).not.toHaveClass("p-4");
    expect(container.firstChild).not.toHaveClass("md:p-6");
  });

  it("merges custom className without breaking width policy", () => {
    const { container } = render(
      <PageContainer className="relative z-10">x</PageContainer>,
    );
    expect(container.firstChild).toHaveClass("relative");
    expect(container.firstChild).toHaveClass("z-10");
    expect(container.firstChild).toHaveClass("max-w-[1440px]");
  });
});
