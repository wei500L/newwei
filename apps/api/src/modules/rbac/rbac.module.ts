import { Module } from "@nestjs/common";
import { RbacController } from "./rbac.controller";
import { RbacService } from "./rbac.service";
import { DatabaseModule } from "../config/database.module";

@Module({
  imports: [DatabaseModule],
  controllers: [RbacController],
  providers: [RbacService],
  exports: [RbacService]
})
export class RbacModule {}
