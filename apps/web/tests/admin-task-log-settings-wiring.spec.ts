import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

describe("admin task log settings wiring", () => {
  it("registers the task-log settings panel in monitoring settings", () => {
    const navigationSource = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/admin/settings/settings-navigation.ts"),
      "utf8",
    );
    const registrySource = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/admin/settings/settings-registry.tsx"),
      "utf8",
    );
    const panelSource = fs.readFileSync(
      path.resolve(webRoot, "components/settings/task-log-settings-panel.tsx"),
      "utf8",
    );

    expect(navigationSource).toContain('titleKey: "settings.tabs.taskLogs"');
    expect(navigationSource).toContain('id: "task-logs"');
    expect(registrySource).toContain('"task-logs": TaskLogSettingsPanel');
    expect(panelSource).toContain("system-settings/task-logs");
  });
});
