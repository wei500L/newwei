import { GeoNominatimSettingsService } from "./geo-nominatim-settings.service";

describe("GeoNominatimSettingsService", () => {
  const prisma = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };

  const env = {
    get: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("ignores invalid persisted and env emails when resolving effective identity", async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      value: {
        userAgent: "modular-console",
        email: "bad@",
      },
    });
    env.get.mockImplementation((key: string) => {
      if (key === "GEO_NOMINATIM_USER_AGENT") {
        return "env-agent";
      }
      if (key === "GEO_NOMINATIM_EMAIL") {
        return "still-bad@";
      }
      return undefined;
    });

    const service = new GeoNominatimSettingsService(prisma as any, env as any);
    const settings = await service.getSettings();

    expect(settings.userAgent).toBe("modular-console");
    expect(settings.email).toBeNull();
    expect(settings.effectiveUserAgent).toBe("modular-console");
    expect(settings.effectiveEmail).toBeNull();
  });

  it("preserves valid emails from overrides and env fallback", async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      value: {
        userAgent: null,
        email: "ops@example.com",
      },
    });
    env.get.mockImplementation((key: string) => {
      if (key === "GEO_NOMINATIM_USER_AGENT") {
        return "env-agent";
      }
      if (key === "GEO_NOMINATIM_EMAIL") {
        return "fallback@example.com";
      }
      return undefined;
    });

    const service = new GeoNominatimSettingsService(prisma as any, env as any);
    const settings = await service.getSettings();
    const identity = await service.getEffectiveIdentity();

    expect(settings.email).toBe("ops@example.com");
    expect(settings.effectiveEmail).toBe("ops@example.com");
    expect(identity).toEqual({
      userAgent: "env-agent",
      email: "ops@example.com",
    });
  });
});
