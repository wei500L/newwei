import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { NewsIndicatorFeatureMetric, NewsIndicatorScopeType } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsIndicatorAssociationService } from "./news-indicator-association.service";

function normalizeEnumValue<T extends Record<string, string>>(value: unknown, enumObject: T): T[keyof T] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const allowed = new Set(Object.values(enumObject));
  return allowed.has(normalized as T[keyof T]) ? (normalized as T[keyof T]) : undefined;
}

@ApiTags("news-indicator")
@ApiBearerAuth()
@Controller("news-indicator")
export class NewsIndicatorController {
  constructor(private readonly associations: NewsIndicatorAssociationService) {}

  @Get("associations")
  @Permissions("dashboards.read")
  async listAssociations(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
    @Query("indicatorSlug") indicatorSlug?: string,
    @Query("scopeType") scopeType?: string,
    @Query("scopeKey") scopeKey?: string,
    @Query("featureMetric") featureMetric?: string
  ) {
    const parsedLimit = typeof limit === "string" && limit.trim() ? Number(limit) : undefined;

    return this.associations.listAssociations(user.orgId, {
      limit: typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      indicatorSlug,
      scopeType: scopeType ? normalizeEnumValue(scopeType, NewsIndicatorScopeType) : undefined,
      scopeKey,
      featureMetric: featureMetric ? normalizeEnumValue(featureMetric, NewsIndicatorFeatureMetric) : undefined
    });
  }

  @Get("associations/:id")
  @Permissions("dashboards.read")
  async getAssociation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Query("backtestsLimit") backtestsLimit?: string
  ) {
    const parsedLimit =
      typeof backtestsLimit === "string" && backtestsLimit.trim() ? Number(backtestsLimit) : undefined;

    return this.associations.getAssociation(user.orgId, id, {
      backtestsLimit: typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined
    });
  }

  @Post("refresh")
  @Permissions("settings.manage")
  async refresh(@CurrentUser() user: AuthenticatedUser) {
    return this.associations.refreshOrg(user.orgId);
  }
}
