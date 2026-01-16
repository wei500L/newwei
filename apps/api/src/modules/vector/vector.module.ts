import { Global, Module } from "@nestjs/common";

import { VectorClientService } from "./vector-client.service";

@Global()
@Module({
  providers: [VectorClientService],
  exports: [VectorClientService]
})
export class VectorModule {}

