import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("items card wiring", () => {
  it("uses href-based navigation for item and event entry points", () => {
    const source = read("app/(app)/items/components/news-card.tsx");

    expect(source).toContain('import Link from "next/link"');
    expect(source).toContain('href={itemHref}');
    expect(source).toContain('href={eventHref}');
    expect(source).toContain('href={itemHref}');
    expect(source).not.toContain('router.push(`/items/${item.id}`)');
    expect(source).not.toContain('router.push(`/events/${item.eventId}`)');
  });

  it("tracks share and negative-feedback actions through the shared behavior helper", () => {
    const source = read("app/(app)/items/components/news-card.tsx");

    expect(source).toContain('shareTrackedNewsLink');
    expect(source).toContain('type: "not_interested"');
    expect(source).toContain('hideSessionBehaviorKey("items", item.id)');
    expect(source).toContain('<Dropdown');
  });
});
