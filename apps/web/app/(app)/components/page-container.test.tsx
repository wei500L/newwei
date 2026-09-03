import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CONTENT_WIDTH_CLASSES, contentWidthClass } from "@/lib/content-widths";

import { PageContainer } from "./page-container";

// App Shell 第一批原语的行为测试：宽度档位来自单一真源（lib/content-widths），
// padding 归 shell 所有（PageContainer 不产生任何边距）。静态渲染断言，
// 不依赖主题/i18n provider——PageContainer 是纯布局的服务端组件。
describe("PageContainer", () => {
  it("applies the default width tier (1440) and centers", () => {
    const { container } = render(
      <PageContainer>
        <span>content</span>
      </PageContainer>,
    );
    expect(container.firstChild).toHaveClass(CONTENT_WIDTH_CLASSES.default);
    expect(container.firstChild).toHaveClass("mx-auto");
    expect(container.firstChild).toHaveClass("w-full");
  });

  it.each([
    ["wide", CONTENT_WIDTH_CLASSES.wide],
    ["wide-board", CONTENT_WIDTH_CLASSES["wide-board"]],
    ["article", CONTENT_WIDTH_CLASSES.article],
    ["full", CONTENT_WIDTH_CLASSES.full],
  ] as const)("applies the %s width tier from the shared source", (width, expectedClass) => {
    const { container } = render(<PageContainer contentWidth={width}>x</PageContainer>);
    expect(container.firstChild).toHaveClass(expectedClass);
  });

  it("adds no padding of its own (shell is the sole padding owner)", () => {
    const { container } = render(<PageContainer>x</PageContainer>);
    const first = container.firstChild as HTMLElement | null;
    const classes = first?.className ?? "";
    for (const paddingClass of ["p-4", "md:p-6", "px-4", "py-6"]) {
      expect(classes).not.toContain(paddingClass);
    }
  });

  it("merges custom className (e.g. vertical rhythm) without breaking width policy", () => {
    const { container } = render(
      <PageContainer className="relative z-10 py-6 md:py-8">x</PageContainer>,
    );
    expect(container.firstChild).toHaveClass("relative");
    expect(container.firstChild).toHaveClass("z-10");
    expect(container.firstChild).toHaveClass("py-6");
    expect(container.firstChild).toHaveClass(CONTENT_WIDTH_CLASSES.default);
  });
});

// 单一真源自身的契约：档位集合与 class 值稳定（shell 与 PageContainer
// 共用，漂移即测试失败）。
describe("content-widths (single source of truth)", () => {
  it("exposes exactly the documented width tiers", () => {
    expect(Object.keys(CONTENT_WIDTH_CLASSES)).toEqual([
      "default",
      "wide",
      "wide-board",
      "article",
      "full",
    ]);
    expect(CONTENT_WIDTH_CLASSES.default).toBe("max-w-[1440px]");
    expect(CONTENT_WIDTH_CLASSES.wide).toBe("max-w-[1920px]");
    expect(CONTENT_WIDTH_CLASSES["wide-board"]).toBe("max-w-[1760px]");
    expect(CONTENT_WIDTH_CLASSES.article).toBe("max-w-[1200px]");
    expect(CONTENT_WIDTH_CLASSES.full).toBe("max-w-none");
  });

  it("contentWidthClass returns the tier class", () => {
    expect(contentWidthClass("article")).toBe("max-w-[1200px]");
  });
});
