import { Global, Module } from "@nestjs/common";

import { ActiveOrgRegistryService } from "./active-org-registry.service";
import { OrgService } from "./org.service";

@Global()
@Module({
  providers: [ActiveOrgRegistryService, OrgService],
  exports: [ActiveOrgRegistryService, OrgService]
})
export class OrgModule {}
