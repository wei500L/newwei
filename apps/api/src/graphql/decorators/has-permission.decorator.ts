import { applyDecorators } from "@nestjs/common";
import { Directive } from "@nestjs/graphql";

import { Permissions } from "../../common/decorators/permissions.decorator";

export const HasPermission = (permission: string) =>
  applyDecorators(Permissions(permission), Directive(`@hasPermission(name: "${permission}")`));
