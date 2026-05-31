import { AssistantRunModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { PrismaService } from "../config/prisma.service";
import { UserNewsBehaviorService } from "../user-news-behavior/user-news-behavior.service";

import type { AuthenticatedUser } from "./auth.service";

const EXPORT_FORMAT = "wei.user-data-export.v1";
const EXPORT_VERSION = 1;
const EXPORT_RATE_LIMIT = 3;
const EXPORT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

interface UserDataExportSections {
  account: unknown;
  membership: unknown;
  userSettings: unknown[];
  contentSubscriptions: unknown[];
  newsBehavior: {
    profile: unknown;
    aggregates: unknown[];
    similaritySnapshot: unknown;
  };
  digest: {
    deliverySchedule: unknown;
  };
  analysisWorkspace: {
    savedViews: unknown[];
    threads: unknown[];
    comments: unknown[];
  };
  notifications: unknown[];
  assistantRuns: unknown[];
}

interface UserDataExportPayload {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  subject: {
    userId: string;
    orgId: string;
  };
  sections: UserDataExportSections;
}

export interface UserDataExportResult {
  buffer: Buffer;
  filename: string;
  byteLength: number;
}

@Injectable()
export class UserDataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RateLimiterService,
    private readonly userNewsBehavior: UserNewsBehaviorService,
  ) {}

  async exportUserData(
    user: AuthenticatedUser,
    ipAddress?: string | null,
  ): Promise<UserDataExportResult> {
    await this.enforceRateLimit(user.orgId, user.id);

    const exportedAt = new Date().toISOString();
    const [
      account,
      membership,
      userSettings,
      contentSubscriptions,
      newsBehaviorProfile,
      newsBehaviorAggregates,
      newsSimilaritySnapshot,
      digestDeliverySchedule,
      savedViews,
      analysisThreads,
      analysisComments,
      notifications,
      assistantRuns,
    ] = await Promise.all([
      this.loadAccount(user.id),
      this.loadMembership(user.orgId, user.id),
      this.loadUserSettings(user.orgId, user.id),
      this.loadContentSubscriptions(user.orgId, user.id),
      this.userNewsBehavior.getProfile(user.orgId, user.id),
      this.loadNewsBehaviorAggregates(user.orgId, user.id),
      this.loadNewsSimilaritySnapshot(user.orgId, user.id),
      this.loadDigestDeliverySchedule(user.orgId, user.id),
      this.loadSavedViews(user.orgId, user.id),
      this.loadAnalysisThreads(user.orgId, user.id),
      this.loadAnalysisComments(user.orgId, user.id),
      this.loadNotifications(user.orgId, user.id),
      this.loadAssistantRuns(user.orgId, user.id),
    ]);

    const sections: UserDataExportSections = {
      account,
      membership,
      userSettings,
      contentSubscriptions,
      newsBehavior: {
        profile: newsBehaviorProfile,
        aggregates: newsBehaviorAggregates,
        similaritySnapshot: newsSimilaritySnapshot,
      },
      digest: {
        deliverySchedule: digestDeliverySchedule,
      },
      analysisWorkspace: {
        savedViews,
        threads: analysisThreads,
        comments: analysisComments,
      },
      notifications,
      assistantRuns,
    };

    const payload: UserDataExportPayload = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt,
      subject: {
        userId: user.id,
        orgId: user.orgId,
      },
      sections,
    };
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const buffer = Buffer.from(json, "utf8");
    const orgSlug = this.resolveOrgSlug(membership);
    const filename = `wei-user-data-${orgSlug}-${exportedAt.slice(0, 10)}.json`;

    await this.writeExportAuditLog({
      orgId: user.orgId,
      actorId: user.id,
      ipAddress,
      byteLength: buffer.byteLength,
      sections,
    });

    return {
      buffer,
      filename,
      byteLength: buffer.byteLength,
    };
  }

  private async enforceRateLimit(orgId: string, userId: string) {
    const allowed = await this.rateLimiter.consume(
      `data-export:user:${orgId}:${userId}`,
      EXPORT_RATE_LIMIT,
      EXPORT_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new TooManyRequestsException(
        "Too many data export requests. Please try again later.",
      );
    }
  }

  private loadAccount(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        pendingEmail: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        totpFactor: {
          select: {
            label: true,
            enrolledAt: true,
            verifiedAt: true,
            disabledAt: true,
            lastUsedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        recoveryCodes: {
          select: {
            usedAt: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: "asc" }],
        },
      },
    });
  }

  private loadMembership(orgId: string, userId: string) {
    return this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      select: {
        id: true,
        userId: true,
        orgId: true,
        roleId: true,
        isActive: true,
        createdAt: true,
        org: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            planTier: true,
            subscriptionStatus: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        role: {
          select: {
            id: true,
            name: true,
            description: true,
            isSystem: true,
            permissions: {
              select: {
                permission: {
                  select: {
                    name: true,
                    description: true,
                  },
                },
              },
              orderBy: [{ permission: { name: "asc" } }],
            },
          },
        },
        roles: {
          select: {
            roleId: true,
            createdAt: true,
            role: {
              select: {
                id: true,
                name: true,
                description: true,
                isSystem: true,
                permissions: {
                  select: {
                    permission: {
                      select: {
                        name: true,
                        description: true,
                      },
                    },
                  },
                  orderBy: [{ permission: { name: "asc" } }],
                },
              },
            },
          },
          orderBy: [{ role: { name: "asc" } }],
        },
      },
    });
  }

  private loadUserSettings(orgId: string, userId: string) {
    return this.prisma.userSetting.findMany({
      where: { orgId, userId },
      select: {
        key: true,
        value: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ key: "asc" }],
    });
  }

  private loadContentSubscriptions(orgId: string, userId: string) {
    return this.prisma.userContentSubscription.findMany({
      where: { orgId, userId },
      select: {
        id: true,
        kind: true,
        normalizedValue: true,
        displayValue: true,
        taxonomyPath: true,
        taxonomyVersion: true,
        source: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ kind: "asc" }, { displayValue: "asc" }],
    });
  }

  private loadNewsBehaviorAggregates(orgId: string, userId: string) {
    return this.prisma.userNewsBehaviorAggregate.findMany({
      where: { orgId, userId },
      select: {
        signalType: true,
        signalKey: true,
        score: true,
        lastInteractedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ signalType: "asc" }, { signalKey: "asc" }],
    });
  }

  private loadNewsSimilaritySnapshot(orgId: string, userId: string) {
    return this.prisma.userNewsSimilaritySnapshot.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
      select: {
        dirty: true,
        computedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  private loadDigestDeliverySchedule(orgId: string, userId: string) {
    return this.prisma.userDigestDeliverySchedule.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
      select: {
        enabled: true,
        timezone: true,
        sendHour: true,
        sendMinute: true,
        nextRunAt: true,
        lastSentAt: true,
        lastStatus: true,
        lastStatusAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  private loadSavedViews(orgId: string, userId: string) {
    return this.prisma.savedAnalysisView.findMany({
      where: { orgId, createdById: userId },
      select: {
        id: true,
        title: true,
        description: true,
        surface: true,
        routePath: true,
        queryState: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  private loadAnalysisThreads(orgId: string, userId: string) {
    return this.prisma.analysisThread.findMany({
      where: { orgId, createdById: userId },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        noteMarkdown: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  private loadAnalysisComments(orgId: string, userId: string) {
    return this.prisma.analysisComment.findMany({
      where: { orgId, createdById: userId },
      select: {
        id: true,
        threadId: true,
        bodyMarkdown: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }],
    });
  }

  private loadNotifications(orgId: string, userId: string) {
    return this.prisma.notification.findMany({
      where: { orgId, userId },
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        data: true,
        readAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  private async loadAssistantRuns(orgId: string, userId: string) {
    const runs = await AssistantRunModel.find(
      { orgId, triggeredById: userId },
      {
        orgId: 1,
        type: 1,
        conversationId: 1,
        status: 1,
        input: 1,
        output: 1,
        summary: 1,
        error: 1,
        model: 1,
        triggeredById: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    )
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return runs.map((run) => ({
      id: this.stringifyId(run._id),
      orgId: run.orgId,
      type: run.type,
      conversationId: run.conversationId ?? null,
      status: run.status,
      input: run.input ?? null,
      output: run.output ?? null,
      summary: run.summary ?? null,
      error: run.error ?? null,
      model: run.model ?? null,
      triggeredById: run.triggeredById ?? null,
      createdAt: this.toIsoString(run.createdAt),
      updatedAt: this.toIsoString(run.updatedAt),
    }));
  }

  private async writeExportAuditLog(input: {
    orgId: string;
    actorId: string;
    ipAddress?: string | null;
    byteLength: number;
    sections: UserDataExportSections;
  }) {
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: input.orgId,
          actorId: input.actorId,
          resource: "data_export",
          action: "download",
          ipAddress: input.ipAddress ?? null,
          metadata: {
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            byteLength: input.byteLength,
            sections: Object.keys(input.sections),
            recordCounts: {
              userSettings: input.sections.userSettings.length,
              contentSubscriptions: input.sections.contentSubscriptions.length,
              newsBehaviorAggregates:
                input.sections.newsBehavior.aggregates.length,
              savedViews: input.sections.analysisWorkspace.savedViews.length,
              analysisThreads:
                input.sections.analysisWorkspace.threads.length,
              analysisComments:
                input.sections.analysisWorkspace.comments.length,
              notifications: input.sections.notifications.length,
              assistantRuns: input.sections.assistantRuns.length,
            },
          },
        },
      },
      {
        orgId: input.orgId,
        actorId: input.actorId,
        resource: "data_export",
        action: "download",
      },
    );
  }

  private resolveOrgSlug(membership: unknown) {
    const maybeMembership = membership as
      | { org?: { slug?: string | null; id?: string | null } | null }
      | null
      | undefined;
    const slug = maybeMembership?.org?.slug ?? maybeMembership?.org?.id ?? "org";
    return this.sanitizeFilenameSegment(slug);
  }

  private sanitizeFilenameSegment(value: string) {
    const normalized = value.trim().replace(/[^a-zA-Z0-9-_]+/g, "-");
    return normalized.replace(/^-+|-+$/g, "").slice(0, 64) || "org";
  }

  private stringifyId(value: unknown) {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object" && "toString" in value) {
      return String(value);
    }
    return null;
  }

  private toIsoString(value: unknown) {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "string") {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return null;
  }
}
