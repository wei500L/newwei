import type { Prisma } from '@prisma/client';

export const toPrismaJsonValue = (value: unknown): Prisma.InputJsonValue => {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
};

export const toPrismaJsonValueOrUndefined = (
  value: unknown
): Prisma.InputJsonValue | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return toPrismaJsonValue(value);
};

