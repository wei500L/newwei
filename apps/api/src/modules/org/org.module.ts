import { Module } from "@nestjs/common";
import { OrgService } from "./org.service";

@Module({
  providers: [OrgService],
  exports: [OrgService]
})
export class OrgModule {}

