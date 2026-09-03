import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { EnvService } from '../config/config.service';

// 常量时间比较（SEC-04）：长度不同直接短路是可接受的信息泄漏
// （token 长度本就由部署方控制），字节内容比较不可被计时侧信道区分。
// Uint8Array.from 规避不同 @types/node 版本下 Buffer 泛型的类型分歧。
const tokensEqual = (left: string, right: string): boolean => {
  const leftBytes = Uint8Array.from(Buffer.from(left));
  const rightBytes = Uint8Array.from(Buffer.from(right));
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

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
    if (!tokensEqual(token, this.env.internalToken)) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}

