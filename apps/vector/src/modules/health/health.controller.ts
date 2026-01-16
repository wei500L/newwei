import { Controller, Get } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

@Controller('healthz')
export class HealthController {
  @Public()
  @Get()
  health() {
    return { ok: true };
  }
}

