import { UserDigestService } from "../user-digest.service";

describe("UserDigestService", () => {
  it("returns default preference when missing", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue(null)
      }
    };
    const contentSubscriptions = {
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusTopics: [],
        focusEntities: [],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const pref = await service.getPreference("org-1", "user-1");

    expect(pref).toEqual(
      expect.objectContaining({
        version: 1,
        windowDays: 3,
        maxEvents: 8,
        includeIndicators: true,
        maxIndicatorsPerEvent: 5
      })
    );
  });

  it("upserts normalized preference on update", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            focusEntities: ["  ACME  ", "", "ACME", "MegaCorp"],
            windowDays: 999,
            maxEvents: 0,
            includeIndicators: false,
            maxIndicatorsPerEvent: 200
          }
        }),
        upsert: jest.fn().mockResolvedValue(null)
      }
    };
    const contentSubscriptions = {
      replaceSubscriptionsFromDigestPreference: jest.fn().mockResolvedValue(undefined),
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusEntities: ["ACME", "MegaCorp"],
        focusTopics: ["macro", "policy"],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const pref = await service.updatePreference("org-1", "user-1", {
      focusTopics: ["  macro  ", "policy"],
      includeIndicators: true
    });

    expect(pref.focusEntities).toEqual(["ACME", "MegaCorp"]);
    expect(pref.focusTopics).toEqual(["macro", "policy"]);
    expect(pref.windowDays).toBe(30);
    expect(pref.maxEvents).toBe(1);
    expect(pref.includeIndicators).toBe(true);
    expect(pref.maxIndicatorsPerEvent).toBe(50);
    expect(contentSubscriptions.replaceSubscriptionsFromDigestPreference).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      { focusTopics: ["  macro  ", "policy"] },
    );

    expect(prisma.userSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          key: "ai:digest:preference:v1"
        }),
        update: expect.objectContaining({
          value: expect.any(Object)
        })
      })
    );
  });

  it("projects focus arrays from content subscriptions on read", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            focusEntities: ["stale entity"],
            focusTopics: ["stale topic"],
            windowDays: 5,
          },
        }),
      },
    };
    const contentSubscriptions = {
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusEntities: ["NVIDIA"],
        focusTopics: ["AI chips"],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const pref = await service.getPreference("org-1", "user-1");

    expect(pref.focusEntities).toEqual(["NVIDIA"]);
    expect(pref.focusTopics).toEqual(["AI chips"]);
    expect(pref.windowDays).toBe(5);
  });
});
