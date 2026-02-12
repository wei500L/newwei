import { describe, expect, it } from "vitest";

import { classifyHeadedIssue, isDisplayDependencyError } from "../lib/crawl-runtime";

describe("crawl runtime issue classifier", () => {
  it("detects DISPLAY/Xvfb dependency errors", () => {
    expect(isDisplayDependencyError("cannot open display :99")).toBe(true);
    expect(isDisplayDependencyError("DISPLAY/Xvfb not available for headless=false")).toBe(true);
    expect(isDisplayDependencyError("Missing X server or $DISPLAY")).toBe(true);
  });

  it("classifies headed display issues", () => {
    expect(classifyHeadedIssue("cannot open display :99")).toBe("display");
    expect(classifyHeadedIssue("xvfb failed to start")).toBe("display");
  });

  it("classifies headed timeout issues", () => {
    expect(classifyHeadedIssue("probe timed out")).toBe("timeout");
    expect(classifyHeadedIssue("Navigation timeout of 30000 ms exceeded")).toBe("timeout");
  });

  it("returns unknown when no signal is present", () => {
    expect(isDisplayDependencyError("HTTP 500 upstream failure")).toBe(false);
    expect(isDisplayDependencyError("xvfb process exited unexpectedly")).toBe(false);
    expect(classifyHeadedIssue("HTTP 500 upstream failure")).toBe("unknown");
    expect(classifyHeadedIssue("xvfb process exited unexpectedly")).toBe("unknown");
    expect(classifyHeadedIssue(undefined)).toBe("unknown");
  });
});
