import { createLogger } from "@modular/utils";
import { Prisma, PrismaClient } from "@prisma/client";

const logger = createLogger({ name: "prisma" });

type PrismaQueryEvent = {
  query: string;
  params: string;
  duration: number;
};

const prisma = new PrismaClient({
  log: [
    { emit: "stdout", level: "error" },
    { emit: "stdout", level: "warn" },
    { emit: "event", level: "query" }
  ]
});

if (process.env.NODE_ENV !== "production") {
  prisma.$on("query", (event: PrismaQueryEvent) => {
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
export type PrismaTransaction = Prisma.TransactionClient;
