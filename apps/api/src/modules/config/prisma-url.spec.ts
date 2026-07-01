import { resolvePrismaMysqlConnectionString } from "@modular/utils";

describe("resolvePrismaMysqlConnectionString", () => {
  it("adds pool parameters to DATABASE_URL when absent", () => {
    const url = resolvePrismaMysqlConnectionString(
      {
        DATABASE_URL: "mysql://user:pass@localhost:3306/app?schema=main",
      },
      {
        connectionLimit: 10,
        poolTimeoutSeconds: 15,
      },
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("schema")).toBe("main");
    expect(parsed.searchParams.get("connection_limit")).toBe("10");
    expect(parsed.searchParams.get("pool_timeout")).toBe("15");
  });

  it("preserves explicit Prisma pool parameters", () => {
    const url = resolvePrismaMysqlConnectionString(
      {
        DATABASE_URL:
          "mysql://user:pass@localhost:3306/app?connection_limit=30&pool_timeout=45",
      },
      {
        connectionLimit: 10,
        poolTimeoutSeconds: 15,
      },
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("connection_limit")).toBe("30");
    expect(parsed.searchParams.get("pool_timeout")).toBe("45");
  });
});
