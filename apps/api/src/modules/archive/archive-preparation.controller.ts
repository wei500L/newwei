import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';

import { ArchivePreparationQueueService } from './archive-preparation-queue.service';

@ApiTags('archive')
@ApiBearerAuth()
@Controller('admin/archive-preparation')
export class ArchivePreparationController {
  constructor(
    private readonly archivePreparationQueue: ArchivePreparationQueueService,
  ) {}

  @Get('status')
  @Permissions('settings.manage')
  async getStatus() {
    return this.archivePreparationQueue.getOperationalStatus();
  }
}
