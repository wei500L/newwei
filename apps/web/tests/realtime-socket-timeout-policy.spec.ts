import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("realtime socket timeout policy", () => {
  it("applies an explicit connect timeout to socket.io realtime hooks", () => {
    const files = [
      "app/(app)/components/use-notification-stream.ts",
      "app/(app)/dashboard/use-queue-events.ts",
      "app/(app)/newsnow/hooks/use-newsnow-stream.ts",
      "app/(app)/admin/quality/quality-content.tsx",
      "app/(app)/admin/ops/news-sources/news-sources-content.tsx",
      "app/(app)/crawl/crawl-tasks.tsx",
      "app/(app)/crawl/[taskId]/task-detail.tsx",
    ];

    for (const relativePath of files) {
      const source = read(relativePath);
      expect(source).toContain("const REALTIME_SOCKET_TIMEOUT_MS = 10_000;");
      expect(source).toContain("timeout: REALTIME_SOCKET_TIMEOUT_MS");
    }
  });
});
