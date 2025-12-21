import { createLogger } from "@modular/utils";
import { PrismaClient } from "@prisma/client";

const logger = createLogger({ name: "prisma" });

const prisma = new PrismaClient({
  log: [
    { emit: "stdout", level: "error" },
    { emit: "stdout", level: "warn" },
    { emit: "event", level: "query" }
  ]
});

if (process.env.NODE_ENV !== "production") {
  prisma.$on("query", (event) => {
    logger.debug(
      {
        query: event.query,
        params: event.params,
        durationMs: event.duration
      },
      "Prisma query executed"
    );
  });
}

process.on("beforeExit", async () => {
  await prisma.$disconnect();
});

export { prisma, PrismaClient };
export type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
