import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { EnvService } from '../config/config.service';

@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const raw = request?.headers?.['x-internal-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new UnauthorizedException('Missing internal token');
    }
    if (token !== this.env.internalToken) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}

