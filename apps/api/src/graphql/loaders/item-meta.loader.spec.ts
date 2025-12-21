import type { PrismaService } from "../../modules/config/prisma.service";

import { ItemMetaLoader } from "./item-meta.loader";

const prisma = {
  itemMeta: {
    findMany: jest.fn()
  }
} as unknown as PrismaService;

describe("ItemMetaLoader", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns entries in request order", async () => {
    const loader = new ItemMetaLoader(prisma);
    prisma.itemMeta.findMany = jest.fn().mockResolvedValue([
      { id: "2", name: "Second", status: "draft", externalId: "2", mongoRef: "", createdAt: new Date(), updatedAt: new Date() },
      { id: "1", name: "First", status: "active", externalId: "1", mongoRef: "", createdAt: new Date(), updatedAt: new Date() }
    ]);

    const dataLoader = loader.generateDataLoader();
    const [first, second] = await dataLoader.loadMany(["1", "2"]);

    expect(first).toMatchObject({ id: "1" });
    expect(second).toMatchObject({ id: "2" });
  });
});
