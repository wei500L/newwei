import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { EnvService } from '../config/config.service';

import { InternalAuthGuard } from './internal-auth.guard';

const createContext = (headers: Record<string, unknown>): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  }) as ExecutionContext;

describe('InternalAuthGuard', () => {
  const env = { internalToken: 'vector-internal-token' } as EnvService;

  it('allows public handlers without a token', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    };
    const guard = new InternalAuthGuard(reflector as never, env);

    expect(guard.canActivate(createContext({}))).toBe(true);
  });

  it('rejects a missing internal token', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    };
    const guard = new InternalAuthGuard(reflector as never, env);

    expect(() => guard.canActivate(createContext({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(createContext({ 'x-internal-token': '   ' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an invalid internal token', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    };
    const guard = new InternalAuthGuard(reflector as never, env);

    expect(() =>
      guard.canActivate(createContext({ 'x-internal-token': 'wrong-token' })),
    ).toThrow(UnauthorizedException);
  });

  it('allows a matching internal token', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    };
    const guard = new InternalAuthGuard(reflector as never, env);

    expect(
      guard.canActivate(createContext({ 'x-internal-token': 'vector-internal-token' })),
    ).toBe(true);
  });
});
