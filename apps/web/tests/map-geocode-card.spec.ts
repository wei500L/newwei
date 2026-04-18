import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("map geocode card wiring", () => {
  it("mounts the geocode lookup card on the map page", () => {
    const source = read("app/(app)/map/page.tsx");

    expect(source).toContain("GeocodeLookupCard");
  });

  it("calls the geo geocode endpoint from the standalone card", () => {
    const source = read("app/(app)/map/geocode-lookup-card.tsx");

    expect(source).toContain("geo/geocode");
    expect(source).toContain("Open in map");
  });
});
