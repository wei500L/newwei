import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("situation monitor interaction wiring", () => {
  it("marks panel controls as interactive so grid dragging ignores them", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");
    const monitorsSource = read(
      "app/(app)/situation-monitor/situation-monitor-monitors-panel.tsx",
    );
    const liveNewsSource = read(
      "app/(app)/situation-monitor/components/situation-monitor-live-news-panel.tsx",
    );

    expect(contentSource).toContain(
      'const SITUATION_MONITOR_INTERACTIVE_SELECTOR = "[data-sm-interactive]";',
    );
    expect(contentSource).toContain(
      'draggableCancel={`${SITUATION_MONITOR_INTERACTIVE_SELECTOR},',
    );
    expect(monitorsSource).toContain('"data-sm-interactive": true,');
    expect(monitorsSource).toContain("onClick={openCreate}");
    expect(monitorsSource).toContain("onClick={() => openEdit(monitor)}");
    expect(liveNewsSource).toContain('"data-sm-interactive": true,');
    expect(liveNewsSource).toContain("onClick={() => setManageOpen(true)}");
  });

  it("uses explicit expand buttons for expandable table rows", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");
    const expandIconMatches = contentSource.match(
      /expandIcon: \(\{ expanded, onExpand, record \}: \{/g,
    );

    expect(expandIconMatches?.length).toBe(2);
    expect(contentSource).toContain(
      "icon={expanded ? <DownOutlined /> : <RightOutlined />}",
    );
    expect(contentSource).toContain(
      'aria-label={`${expanded ? collapseRowLabel : expandRowLabel} row`}',
    );
    expect(contentSource).toContain("onExpand(record, event);");
  });
});
