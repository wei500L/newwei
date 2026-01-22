import { describe, expect, it } from "vitest";

import { NotificationType } from "../graphql/generated";
import { dedupeNotifications, getNotificationDedupeKey, upsertNotification } from "../lib/notification-dedupe";

describe("notification dedupe helpers", () => {
  it("generates a stable key for identical payloads (data key order does not matter)", () => {
    const a = {
      id: "a",
      type: NotificationType.System,
      title: "Hello",
      body: "World",
      data: { b: 2, a: 1, nested: { z: true, a: "x" } },
      createdAt: "2024-01-01T00:00:00.000Z",
      readAt: null
    };

    const b = {
      ...a,
      id: "b",
      data: { nested: { a: "x", z: true }, a: 1, b: 2 }
    };

    expect(getNotificationDedupeKey(a)).toBe(getNotificationDedupeKey(b));
  });

  it("dedupes by id and by content key, and preserves readAt when either copy is read", () => {
    const base = {
      id: "id-1",
      type: NotificationType.AlertTriggered,
      title: "Alert",
      body: "Triggered",
      data: { alertEventId: "evt-1" },
      createdAt: "2024-01-01T00:00:00.123Z",
      readAt: null
    };

    const sameIdRead = { ...base, readAt: "2024-01-01T00:00:10.000Z" };
    const differentIdSameContent = { ...base, id: "id-2" };

    const deduped = dedupeNotifications([base, sameIdRead, differentIdSameContent]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("id-1");
    expect(deduped[0]?.readAt).toBe("2024-01-01T00:00:10.000Z");
  });

  it("upserts new notifications to the front and merges duplicates in place", () => {
    const n1 = {
      id: "id-1",
      type: NotificationType.System,
      title: "N1",
      body: null,
      data: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      readAt: null
    };

    const n2 = {
      id: "id-2",
      type: NotificationType.System,
      title: "N2",
      body: null,
      data: null,
      createdAt: "2024-01-01T00:00:01.000Z",
      readAt: null
    };

    const inserted = upsertNotification([n1], n2);
    expect(inserted.map((item) => item.id)).toEqual(["id-2", "id-1"]);

    const duplicate = { ...n1, id: "id-3", readAt: "2024-01-01T00:00:02.000Z" };
    const merged = upsertNotification([n1, n2], duplicate);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe("id-1");
    expect(merged[0]?.readAt).toBe("2024-01-01T00:00:02.000Z");
  });
});
