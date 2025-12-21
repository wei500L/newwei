import { Global, Module } from "@nestjs/common";

import { MongoProvider } from "./mongo.provider";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService, MongoProvider],
  exports: [PrismaService, MongoProvider]
})
export class DatabaseModule {}
