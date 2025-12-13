import type { CustomDecorator } from "@nestjs/common";
import { SetMetadata } from "@nestjs/common";

export const PERMISSIONS_KEY = "permissions";

export enum PermissionsMode {
  Any = "any",
  All = "all"
}

export interface PermissionsRequirement {
  permissions: string[];
  mode: PermissionsMode;
}

export const Permissions = (...permissions: string[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, { permissions, mode: PermissionsMode.Any } satisfies PermissionsRequirement);

export const PermissionsAll = (...permissions: string[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, { permissions, mode: PermissionsMode.All } satisfies PermissionsRequirement);

export function normalizePermissionsRequirement(value: unknown): PermissionsRequirement | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value) && value.every((permission) => typeof permission === "string")) {
    return { permissions: value, mode: PermissionsMode.Any };
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const maybeRequirement = value as Partial<PermissionsRequirement>;
  if (!Array.isArray(maybeRequirement.permissions)) {
    return undefined;
  }
  if (maybeRequirement.permissions.some((permission) => typeof permission !== "string")) {
    return undefined;
  }

  if (maybeRequirement.mode !== PermissionsMode.Any && maybeRequirement.mode !== PermissionsMode.All) {
    return undefined;
  }

  return { permissions: maybeRequirement.permissions, mode: maybeRequirement.mode };
}
