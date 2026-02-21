import { ArchiveClassifier } from "../archive.classifier";
import { ArchiveRegion, ArchiveVertical } from "../archive.types";

describe("ArchiveClassifier", () => {
  const classifier = new ArchiveClassifier();

  it("classifies East Sea storyline in APAC", () => {
    const result = classifier.classify({
      title: "Japan releases defense white paper on regional tensions",
      summary: "Tokyo and Seoul discussed East China Sea posture.",
      topics: ["security", "east china sea"],
      entities: [{ name: "Japan" }, { name: "South Korea" }],
      location: "Japan",
    });

    expect(result.region).toBe(ArchiveRegion.APAC);
    expect(result.vertical).toBe(ArchiveVertical.EAST_SEA);
    expect(result.countryLabel).toBe("Japan");
  });

  it("classifies South Sea storyline using keywords", () => {
    const result = classifier.classify({
      title: "Patrols increase near Scarborough Shoal",
      summary: "New coast guard activity observed in the South China Sea.",
      topics: ["maritime", "south china sea"],
      entities: [{ name: "Philippines" }],
      location: "Philippines",
    });

    expect(result.region).toBe(ArchiveRegion.APAC);
    expect(result.vertical).toBe(ArchiveVertical.SOUTH_SEA);
  });

  it("falls back to OTHER region and foreign affairs vertical", () => {
    const result = classifier.classify({
      title: "Broad diplomatic developments discussed",
      summary: "Several countries announced new sanctions and responses.",
      topics: ["diplomacy"],
      entities: [],
      location: null,
    });

    expect(result.region).toBe(ArchiveRegion.OTHER);
    expect(result.vertical).toBe(ArchiveVertical.FOREIGN_AFFAIRS);
  });

  it("returns locale-neutral empty country label when no country signal exists", () => {
    const result = classifier.classify({
      title: null,
      summary: null,
      topics: [],
      entities: [],
      location: null,
    });

    expect(result.countryCode).toBeNull();
    expect(result.countryLabel).toBe("");
  });
});
