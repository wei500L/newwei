import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("frontend bundle splitting wiring", () => {
  it("loads echarts through the dynamic chart wrapper", () => {
    const source = read("components/echart.tsx");

    expect(source).toContain("dynamic<EchartProps>");
    expect(source).toContain('import("./echart.client")');
    expect(source).not.toContain("DashboardChart as DashboardChartInner");
  });

  it("keeps map and finance heavy widgets behind dynamic imports", () => {
    const mapPage = read("app/(app)/map/page.tsx");
    const financeOverview = read("app/(app)/finance/market-overview.tsx");
    const financeContent = read("app/(app)/finance/market-content.tsx");

    expect(mapPage).not.toContain('from "@/app/(app)/dashboard/charts/war-map"');
    expect(financeOverview).not.toContain(
      'from "@/app/(app)/dashboard/metric-drilldown"',
    );
    expect(financeOverview).not.toContain(
      'from "@/app/(app)/dashboard/charts/financial-candlestick"',
    );
    expect(financeContent).not.toContain("import KeyMonitorPage");
  });

  it("keeps cytoscape out of the knowledge graph workspace and content entry", () => {
    const workspace = read("app/(app)/knowledge-graph/knowledge-graph-workspace.tsx");
    const content = read("app/(app)/knowledge-graph/knowledge-graph-content.tsx");
    const canvas = read("app/(app)/knowledge-graph/knowledge-graph-canvas.tsx");

    expect(workspace).not.toContain('from "./knowledge-graph-content"');
    expect(content).not.toContain('from "cytoscape"');
    expect(content).not.toContain('from "cytoscape-fcose"');
    expect(canvas).toContain('from "cytoscape"');
    expect(canvas).toContain('from "cytoscape-fcose"');
  });
});
