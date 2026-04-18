import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rootPagePath = path.resolve(__dirname, "../app/page.tsx");
const channelPagePath = path.resolve(__dirname, "../app/(portal)/channel/[topic]/page.tsx");

describe("public portal routing", () => {
  it("renders the public portal from the root route instead of redirecting to /today", () => {
    const source = fs.readFileSync(rootPagePath, "utf8");

    expect(source).toContain("fetchPublicPortalHome()");
    expect(source).toContain("<PortalHomeView payload={payload} isAuthenticated={Boolean(session)} />");
    expect(source).not.toContain('redirect("/today")');
  });

  it("wires topic pages through the public portal channel view", () => {
    const source = fs.readFileSync(channelPagePath, "utf8");

    expect(source).toContain("fetchPublicPortalChannel(topic)");
    expect(source).toContain("<PortalChannelView payload={payload} isAuthenticated={Boolean(session)} />");
  });
});
