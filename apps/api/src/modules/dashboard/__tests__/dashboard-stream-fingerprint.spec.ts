import { createDashboardStreamFingerprint } from "../dashboard.controller";

describe("createDashboardStreamFingerprint", () => {
  it("returns the same fingerprint for identical payloads", () => {
    const payload = {
      updatedAt: "2026-03-03T00:00:00.000Z",
      events: [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ],
    };

    expect(createDashboardStreamFingerprint(payload)).toBe(
      createDashboardStreamFingerprint(payload),
    );
  });

  it("changes fingerprint when payload content changes with same length and updatedAt", () => {
    const before = {
      updatedAt: "2026-03-03T00:00:00.000Z",
      events: [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ],
    };
    const after = {
      updatedAt: "2026-03-03T00:00:00.000Z",
      events: [
        { id: "a", value: 1 },
        { id: "b", value: 3 },
      ],
    };

    expect(before.events).toHaveLength(after.events.length);
    expect(before.updatedAt).toBe(after.updatedAt);
    expect(createDashboardStreamFingerprint(before)).not.toBe(
      createDashboardStreamFingerprint(after),
    );
  });

  it("falls back safely when payload is not JSON-serializable", () => {
    expect(createDashboardStreamFingerprint({ value: BigInt(1) })).toEqual(
      expect.any(String),
    );
  });
});
