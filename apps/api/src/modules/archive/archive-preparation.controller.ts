import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

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
  async getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.archivePreparationQueue.getOperationalStatus(user.orgId);
  }
}
