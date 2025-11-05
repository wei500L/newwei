import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { MongoProvider } from "./mongo.provider";

@Global()
@Module({
  providers: [PrismaService, MongoProvider],
  exports: [PrismaService, MongoProvider]
})
export class DatabaseModule {}
