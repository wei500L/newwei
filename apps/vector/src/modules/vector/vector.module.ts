import { Module } from '@nestjs/common';

import { QdrantService } from './qdrant.service';
import { VectorController } from './vector.controller';
import { VectorService } from './vector.service';

@Module({
  controllers: [VectorController],
  providers: [VectorService, QdrantService],
})
export class VectorModule {}

