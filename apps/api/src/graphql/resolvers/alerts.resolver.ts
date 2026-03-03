import { ForbiddenException, Inject, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { PubSubEngine, withFilter } from "graphql-subscriptions";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { ALERTS_PUBSUB, type AlertEventPayload } from "../../modules/alerts/alerts.pubsub";
import { AlertsService } from "../../modules/alerts/alerts.service";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AlertChannelInput, UpdateAlertChannelInput, UpdateAlertEventStatusInput, UpsertAlertRuleInput } from "../dto/alert.input";
import type { GqlRequest } from "../graphql.types";
import { AlertChannelModel, AlertEventModel, AlertEventReplayModel, AlertRuleModel, AlertRuleTuningSuggestionModel } from "../models/alert.model";

const normalizeRequiredMetricSlug = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizeOptionalMetricSlug = (value: unknown): string | undefined => {
  const normalized = normalizeRequiredMetricSlug(value);
  return normalized || undefined;
};

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class AlertsResolver {
  constructor(private readonly alerts: AlertsService, @Inject(ALERTS_PUBSUB) private readonly pubsub: PubSubEngine) {}

  @HasPermission("alerts.read")
  @Query(() => [AlertChannelModel])
  async alertChannels(@Context("req") req: GqlRequest): Promise<AlertChannelModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const channels = await this.alerts.listChannels(requester.orgId);
    return channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      target: channel.target,
      isActive: channel.isActive,
      config: (channel.config as Record<string, unknown> | null) ?? null,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    }));
  }

  @HasPermission("alerts.read")
  @Query(() => [AlertRuleModel])
  async alertRules(@Context("req") req: GqlRequest): Promise<AlertRuleModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const rules = await this.alerts.listRules(requester.orgId);
    return rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description ?? undefined,
      severity: rule.severity,
      status: rule.status,
      metricProvider: rule.metricProvider,
      metricSlug: normalizeRequiredMetricSlug(rule.metricSlug),
      operator: rule.operator,
      thresholdValue: rule.thresholdValue ? Number(rule.thresholdValue) : null,
      thresholdLower: rule.thresholdLower ? Number(rule.thresholdLower) : null,
      thresholdUpper: rule.thresholdUpper ? Number(rule.thresholdUpper) : null,
      changeWindowMin: rule.changeWindowMin,
      cooldownSeconds: rule.cooldownSeconds,
      checkIntervalSec: rule.checkIntervalSec,
      lastTriggeredAt: rule.lastTriggeredAt ?? undefined,
      metadata: rule.metadata as Record<string, unknown> | null,
      channels: rule.channels
        .map((link) => link.channel)
        .filter((channel): channel is NonNullable<typeof channel> => !!channel)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          target: channel.target,
          isActive: channel.isActive,
          config: (channel.config as Record<string, unknown> | null) ?? null,
          createdAt: channel.createdAt,
          updatedAt: channel.updatedAt
        }))
    }));
  }

  @HasPermission("alerts.read")
  @Query(() => [AlertEventModel])
  async alertEvents(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("metricSlug", { type: () => String, nullable: true }) metricSlug?: string
  ): Promise<AlertEventModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const events = await this.alerts.listEvents(requester.orgId, limit ?? 50, metricSlug);
    return events.map((event) => ({
      id: event.id,
      triggeredAt: event.triggeredAt,
      metricValue: Number(event.metricValue),
      changePercent: event.changePercent ?? undefined,
      severity: event.severity,
      status: event.status,
      message: event.message ?? undefined,
      ruleId: event.ruleId,
      ruleName: event.rule?.name ?? undefined,
      metricProvider: event.rule?.metricProvider ?? undefined,
      metricSlug: normalizeOptionalMetricSlug(event.rule?.metricSlug),
      operator: event.rule?.operator ?? undefined,
      thresholdValue: event.rule?.thresholdValue ? Number(event.rule.thresholdValue) : null,
      thresholdLower: event.rule?.thresholdLower ? Number(event.rule.thresholdLower) : null,
      thresholdUpper: event.rule?.thresholdUpper ? Number(event.rule.thresholdUpper) : null,
      changeWindowMin: event.rule?.changeWindowMin ?? null,
      context: event.context as Record<string, unknown> | null,
      deliveries:
        event.deliveries?.map((delivery) => {
          const snapshot =
            delivery.targetSnapshot && typeof delivery.targetSnapshot === "object" && !Array.isArray(delivery.targetSnapshot)
              ? (delivery.targetSnapshot as Record<string, unknown>)
              : null;
          const snapshotTarget =
            typeof snapshot?.target === "string"
              ? snapshot.target
              : typeof snapshot?.userId === "string"
                ? snapshot.userId
                : undefined;
          const snapshotName = typeof snapshot?.name === "string" ? snapshot.name : undefined;
          return {
            id: delivery.id,
            status: delivery.status,
            error: delivery.error ?? undefined,
            sentAt: delivery.sentAt ?? undefined,
            channelType: delivery.channelType,
            channelName: delivery.channel?.name ?? snapshotName ?? (delivery.channelType === "in_app" ? "In-app" : undefined),
            target: delivery.channel?.target ?? snapshotTarget
          };
        }) ?? []
    }));
  }

  @HasPermission("alerts.read")
  @Query(() => AlertEventReplayModel, { nullable: true })
  async alertEventReplay(
    @Context("req") req: GqlRequest,
    @Args("eventId") eventId: string,
    @Args("windowDays", { type: () => Int, nullable: true }) windowDays?: number
  ): Promise<AlertEventReplayModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.alerts.getEventReplay(requester.orgId, eventId, windowDays ?? 30);
  }

  @HasPermission("alerts.manage")
  @Query(() => AlertRuleTuningSuggestionModel, { nullable: true })
  async alertRuleTuningSuggestion(
    @Context("req") req: GqlRequest,
    @Args("ruleId") ruleId: string,
    @Args("windowDays", { type: () => Int, nullable: true }) windowDays?: number
  ): Promise<AlertRuleTuningSuggestionModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.alerts.getRuleTuningSuggestion(requester.orgId, ruleId, windowDays ?? 30);
  }

  @HasPermission("alerts.manage")
  @Mutation(() => AlertRuleModel)
  async upsertAlertRule(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpsertAlertRuleInput
  ): Promise<AlertRuleModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const rule = await this.alerts.upsertRule(requester.orgId, input, requester.id);
    const hydrated = await this.alerts.listRules(requester.orgId);
    const updated = hydrated.find((entry) => entry.id === rule.id);
    if (!updated) {
      throw new Error("Failed to reload rule");
    }
    return {
      id: updated.id,
      name: updated.name,
      description: updated.description ?? undefined,
      severity: updated.severity,
      status: updated.status,
      metricProvider: updated.metricProvider,
      metricSlug: normalizeRequiredMetricSlug(updated.metricSlug),
      operator: updated.operator,
      thresholdValue: updated.thresholdValue ? Number(updated.thresholdValue) : null,
      thresholdLower: updated.thresholdLower ? Number(updated.thresholdLower) : null,
      thresholdUpper: updated.thresholdUpper ? Number(updated.thresholdUpper) : null,
      changeWindowMin: updated.changeWindowMin,
      cooldownSeconds: updated.cooldownSeconds,
      checkIntervalSec: updated.checkIntervalSec,
      lastTriggeredAt: updated.lastTriggeredAt ?? undefined,
      metadata: updated.metadata as Record<string, unknown> | null,
      channels: updated.channels
        .map((link) => link.channel)
        .filter((channel): channel is NonNullable<typeof channel> => !!channel)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          target: channel.target,
          isActive: channel.isActive,
          config: (channel.config as Record<string, unknown> | null) ?? null,
          createdAt: channel.createdAt,
          updatedAt: channel.updatedAt
        }))
    };
  }

  @HasPermission("alerts.manage")
  @Mutation(() => Boolean)
  async deleteAlertRule(@Context("req") req: GqlRequest, @Args("ruleId") ruleId: string): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.alerts.deleteRule(requester.orgId, ruleId);
  }

  @HasPermission("alerts.manage")
  @Mutation(() => AlertChannelModel)
  async createAlertChannel(
    @Context("req") req: GqlRequest,
    @Args("input") input: AlertChannelInput
  ): Promise<AlertChannelModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const channel = await this.alerts.createChannel(requester.orgId, input, requester.id);
    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      target: channel.target,
      isActive: channel.isActive,
      config: (channel.config as Record<string, unknown> | null) ?? null,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    };
  }

  @HasPermission("alerts.manage")
  @Mutation(() => AlertChannelModel)
  async updateAlertChannel(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAlertChannelInput
  ): Promise<AlertChannelModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const channel = await this.alerts.updateChannel(requester.orgId, input.id, input);
    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      target: channel.target,
      isActive: channel.isActive,
      config: (channel.config as Record<string, unknown> | null) ?? null,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    };
  }

  @HasPermission("alerts.manage")
  @Mutation(() => Boolean)
  async deleteAlertChannel(@Context("req") req: GqlRequest, @Args("channelId") channelId: string): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.alerts.deleteChannel(requester.orgId, channelId);
  }

  @HasPermission("alerts.manage")
  @Mutation(() => Boolean)
  async triggerAlertRule(@Args("ruleId") ruleId: string): Promise<boolean> {
    await this.alerts.enqueueRuleCheck(ruleId);
    return true;
  }

  @HasPermission("alerts.manage")
  @Mutation(() => AlertEventModel)
  async updateAlertEventStatus(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAlertEventStatusInput
  ): Promise<AlertEventModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const event = await this.alerts.updateEventStatus(requester.orgId, input.eventId, input.status, input.note, requester.id);
    return {
      id: event.id,
      triggeredAt: event.triggeredAt,
      metricValue: Number(event.metricValue),
      changePercent: event.changePercent ?? undefined,
      severity: event.severity,
      status: event.status,
      message: event.message ?? undefined,
      ruleId: event.ruleId,
      ruleName: event.rule?.name ?? undefined,
      metricProvider: event.rule?.metricProvider ?? undefined,
      metricSlug: normalizeOptionalMetricSlug(event.rule?.metricSlug),
      operator: event.rule?.operator ?? undefined,
      thresholdValue: event.rule?.thresholdValue ? Number(event.rule.thresholdValue) : null,
      thresholdLower: event.rule?.thresholdLower ? Number(event.rule.thresholdLower) : null,
      thresholdUpper: event.rule?.thresholdUpper ? Number(event.rule.thresholdUpper) : null,
      changeWindowMin: event.rule?.changeWindowMin ?? null,
      context: event.context as Record<string, unknown> | null,
      deliveries:
        event.deliveries?.map((delivery) => {
          const snapshot =
            delivery.targetSnapshot && typeof delivery.targetSnapshot === "object" && !Array.isArray(delivery.targetSnapshot)
              ? (delivery.targetSnapshot as Record<string, unknown>)
              : null;
          const snapshotTarget =
            typeof snapshot?.target === "string"
              ? snapshot.target
              : typeof snapshot?.userId === "string"
                ? snapshot.userId
                : undefined;
          const snapshotName = typeof snapshot?.name === "string" ? snapshot.name : undefined;
          return {
            id: delivery.id,
            status: delivery.status,
            error: delivery.error ?? undefined,
            sentAt: delivery.sentAt ?? undefined,
            channelType: delivery.channelType,
            channelName: delivery.channel?.name ?? snapshotName ?? (delivery.channelType === "in_app" ? "In-app" : undefined),
            target: delivery.channel?.target ?? snapshotTarget
          };
        }) ?? []
    };
  }

  @HasPermission("alerts.read")
  @Subscription(() => AlertEventModel, {
    name: "alertEvents",
    resolve: (payload: AlertEventPayload) => {
      const triggeredAt = payload.event.triggeredAt instanceof Date ? payload.event.triggeredAt : new Date(payload.event.triggeredAt);
      return {
        id: payload.event.id,
        triggeredAt,
        metricValue: payload.event.metricValue,
        changePercent: payload.event.changePercent ?? null,
        severity: payload.event.severity,
        status: payload.event.status,
        message: payload.event.message ?? undefined,
        ruleId: payload.event.ruleId ?? undefined,
        ruleName: payload.event.ruleName ?? undefined,
        metricProvider: payload.event.metricProvider ?? undefined,
        metricSlug: normalizeOptionalMetricSlug(payload.event.metricSlug),
        context: payload.event.context ?? null,
        deliveries: []
      };
    }
  })
  alertEventsSubscription(@Context("req") req: GqlRequest) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return withFilter(
      () => this.pubsub.asyncIterator("alertEvents"),
      (payload: { orgId: string }) => payload.orgId === requester.orgId
    )();
  }
}
