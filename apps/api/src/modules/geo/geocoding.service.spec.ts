import { GeocodingService, GeocodeProvider } from "./geocoding.service";

describe("GeocodingService", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  it("returns cached results without hitting the network", async () => {
    const cache = {
      get: jest.fn().mockResolvedValueOnce({
        ok: true,
        cachedAt: Date.now(),
        result: {
          lat: 40.7128,
          lng: -74.006,
          provider: GeocodeProvider.Nominatim,
          query: "New York"
        }
      }),
      set: jest.fn()
    };
    const rateLimiter = { consume: jest.fn() };
    const env = { get: jest.fn() };
    const service = new GeocodingService(cache as any, rateLimiter as any, env as any);

    const result = await service.geocode("New York");
    expect(result).toEqual(
      expect.objectContaining({
        lat: 40.7128,
        lng: -74.006,
        provider: GeocodeProvider.Nominatim
      })
    );
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches from Nominatim and caches the result", async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined)
    };
    const rateLimiter = { consume: jest.fn().mockResolvedValue(true) };
    const env = {
      get: jest.fn((key: string) => {
        switch (key) {
          case "GEO_NOMINATIM_BASE_URL":
            return "https://nominatim.test";
          case "GEO_NOMINATIM_USER_AGENT":
            return "modular-api-test";
          case "GEO_GEOCODE_TIMEOUT_MS":
            return 2_000;
          case "GEO_GEOCODE_CACHE_TTL_SECONDS":
            return 120;
          default:
            return undefined;
        }
      })
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "40.7128",
          lon: "-74.0060",
          display_name: "New York, United States",
          boundingbox: ["40.4", "40.9", "-74.3", "-73.7"],
          address: { country_code: "us" }
        }
      ]
    });

    const service = new GeocodingService(cache as any, rateLimiter as any, env as any);
    const result = await service.geocode("New York", { countryCodeAlpha2: "US" });

    expect(rateLimiter.consume).toHaveBeenCalledWith("geocode:nominatim", expect.any(Number), 1);
    expect(fetchMock).toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        lat: 40.7128,
        lng: -74.006,
        displayName: "New York, United States",
        provider: GeocodeProvider.Nominatim,
        countryCodeAlpha2: "US"
      })
    );
  });

  it("skips network calls when rate limiter denies the request", async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn()
    };
    const rateLimiter = { consume: jest.fn().mockResolvedValue(false) };
    const env = { get: jest.fn() };
    const service = new GeocodingService(cache as any, rateLimiter as any, env as any);

    const result = await service.geocode("New York", { countryCodeAlpha2: "US" });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("negative-caches empty results", async () => {
    const cache = {
      get: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ok: false, cachedAt: Date.now() }),
      set: jest.fn().mockResolvedValue(undefined)
    };
    const rateLimiter = { consume: jest.fn().mockResolvedValue(true) };
    const env = { get: jest.fn() };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => []
    });

    const service = new GeocodingService(cache as any, rateLimiter as any, env as any);

    const first = await service.geocode("Unknown place");
    expect(first).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ok: false }), expect.any(Number));

    const second = await service.geocode("Unknown place");
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
  });
});

