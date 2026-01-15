/**
 * JavaScript Code Audit Logging Service
 *
 * Logs all jsCode usage for security monitoring and compliance.
 * Stores audit logs in MongoDB for security review and retention policy enforcement.
 *
 * Security Issue: NP-SEC-002
 * Solution ID: SOL-NP-SEC-002-p5n9
 */

import { Injectable, Logger } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";

import { EnvService } from "../../config/config.service";
import type { JsCodeValidationResult } from "../validators/js-code.validator";

export interface JsCodeAuditContext {
  orgId: string;
  userId: string;
  taskId?: string;
  jsCode: string[];
  validationResult: JsCodeValidationResult;
  sourceIp?: string;
  userAgent?: string;
  endpoint?: string;
}

interface JsCodeAuditLogDocument {
  orgId: string;
  userId: string;
  taskId?: string;
  jsCodeTruncated: string[];
  jsCodeCount: number;
  totalLength: number;
  validationResult: {
    valid: boolean;
    blockedPatterns: string[];
    warnings: string[];
  };
  sourceIp?: string;
  userAgent?: string;
  endpoint?: string;
  timestamp: Date;
  expiresAt: Date;
}

/**
 * Maximum length for each jsCode entry in audit logs.
 * Full code is truncated to prevent excessive storage.
 */
const MAX_AUDIT_CODE_LENGTH = 500;

/**
 * Default retention period in days for audit logs.
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Collection name for audit logs.
 */
const AUDIT_COLLECTION_NAME = "js_code_audit_logs";

@Injectable()
export class JsCodeAuditService {
  private readonly logger = new Logger(JsCodeAuditService.name);
  private readonly retentionDays: number;
  private indexesEnsured = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly env: EnvService
  ) {
    this.retentionDays = this.env.crawl4aiConfig.jsCodeAuditRetentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  /**
   * Logs jsCode usage with full context for security monitoring.
   *
   * @param context - The audit context containing all relevant information
   */
  async logJsCodeUsage(context: JsCodeAuditContext): Promise<void> {
    if (!this.isAuditEnabled()) {
      return;
    }

    try {
      await this.ensureIndexes();

      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);

      const document: JsCodeAuditLogDocument = {
        orgId: context.orgId,
        userId: context.userId,
        taskId: context.taskId,
        jsCodeTruncated: this.truncateJsCode(context.jsCode),
        jsCodeCount: context.jsCode.length,
        totalLength: context.jsCode.reduce((sum, code) => sum + code.length, 0),
        validationResult: {
          valid: context.validationResult.valid,
          blockedPatterns: context.validationResult.blockedPatterns,
          warnings: context.validationResult.warnings
        },
        sourceIp: this.sanitizeIp(context.sourceIp),
        userAgent: this.truncateUserAgent(context.userAgent),
        endpoint: context.endpoint,
        timestamp: now,
        expiresAt
      };

      await this.getCollection().insertOne(document);

      // Log blocked attempts at warning level for immediate visibility
      if (!context.validationResult.valid) {
        this.logger.warn(
          `Blocked jsCode attempt: orgId=${context.orgId}, userId=${context.userId}, ` +
            `patterns=${context.validationResult.blockedPatterns.join(", ")}`
        );
      }
    } catch (error) {
      // Log error but don't fail the request - audit is non-critical
      this.logger.error(`Failed to log jsCode audit: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Queries audit logs for security review.
   *
   * @param filter - Query filter options
   * @param options - Pagination options
   * @returns Array of audit log entries
   */
  async queryAuditLogs(
    filter: {
      orgId?: string;
      userId?: string;
      validOnly?: boolean;
      fromDate?: Date;
      toDate?: Date;
    },
    options: {
      limit?: number;
      skip?: number;
      sortOrder?: "asc" | "desc";
    } = {}
  ): Promise<JsCodeAuditLogDocument[]> {
    const query: Record<string, unknown> = {};

    if (filter.orgId) {
      query.orgId = filter.orgId;
    }
    if (filter.userId) {
      query.userId = filter.userId;
    }
    if (typeof filter.validOnly === "boolean") {
      query["validationResult.valid"] = filter.validOnly;
    }
    if (filter.fromDate || filter.toDate) {
      query.timestamp = {};
      if (filter.fromDate) {
        (query.timestamp as Record<string, Date>).$gte = filter.fromDate;
      }
      if (filter.toDate) {
        (query.timestamp as Record<string, Date>).$lte = filter.toDate;
      }
    }

    const limit = Math.min(options.limit ?? 100, 1000);
    const skip = options.skip ?? 0;
    const sortOrder = options.sortOrder === "asc" ? 1 : -1;

    return this.getCollection()
      .find(query)
      .sort({ timestamp: sortOrder })
      .skip(skip)
      .limit(limit)
      .toArray() as Promise<JsCodeAuditLogDocument[]>;
  }

  /**
   * Gets statistics for jsCode usage.
   *
   * @param orgId - Optional organization ID filter
   * @param fromDate - Start date for statistics
   * @param toDate - End date for statistics
   */
  async getUsageStatistics(
    orgId?: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<{
    totalRequests: number;
    blockedRequests: number;
    uniqueUsers: number;
    topBlockedPatterns: Array<{ pattern: string; count: number }>;
  }> {
    const matchStage: Record<string, unknown> = {};

    if (orgId) {
      matchStage.orgId = orgId;
    }
    if (fromDate || toDate) {
      matchStage.timestamp = {};
      if (fromDate) {
        (matchStage.timestamp as Record<string, Date>).$gte = fromDate;
      }
      if (toDate) {
        (matchStage.timestamp as Record<string, Date>).$lte = toDate;
      }
    }

    const pipeline = [
      { $match: matchStage },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                blockedRequests: {
                  $sum: { $cond: [{ $eq: ["$validationResult.valid", false] }, 1, 0] }
                },
                uniqueUsers: { $addToSet: "$userId" }
              }
            }
          ],
          blockedPatterns: [
            { $match: { "validationResult.valid": false } },
            { $unwind: "$validationResult.blockedPatterns" },
            {
              $group: {
                _id: "$validationResult.blockedPatterns",
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ]
        }
      }
    ];

    const results = await this.getCollection().aggregate(pipeline).toArray();
    const facetResult = results[0] as {
      totals: Array<{ totalRequests: number; blockedRequests: number; uniqueUsers: string[] }>;
      blockedPatterns: Array<{ _id: string; count: number }>;
    };

    const totals = facetResult?.totals?.[0];
    const blockedPatterns = facetResult?.blockedPatterns ?? [];

    return {
      totalRequests: totals?.totalRequests ?? 0,
      blockedRequests: totals?.blockedRequests ?? 0,
      uniqueUsers: totals?.uniqueUsers?.length ?? 0,
      topBlockedPatterns: blockedPatterns.map((p) => ({
        pattern: p._id,
        count: p.count
      }))
    };
  }

  /**
   * Manually triggers cleanup of expired audit logs.
   * Note: MongoDB TTL index handles automatic cleanup, this is for manual intervention.
   */
  async cleanupExpiredLogs(): Promise<number> {
    const result = await this.getCollection().deleteMany({
      expiresAt: { $lt: new Date() }
    });
    return result.deletedCount;
  }

  private getCollection() {
    return this.connection.db.collection(AUDIT_COLLECTION_NAME);
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) {
      return;
    }

    try {
      const collection = this.getCollection();

      // TTL index for automatic expiration
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

      // Query indexes
      await collection.createIndex({ orgId: 1, timestamp: -1 });
      await collection.createIndex({ userId: 1, timestamp: -1 });
      await collection.createIndex({ "validationResult.valid": 1, timestamp: -1 });
      await collection.createIndex({ timestamp: -1 });

      this.indexesEnsured = true;
    } catch (error) {
      this.logger.warn(`Failed to ensure indexes: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private isAuditEnabled(): boolean {
    return this.env.crawl4aiConfig.jsCodeAuditEnabled !== false;
  }

  private truncateJsCode(jsCode: string[]): string[] {
    return jsCode.map((code) => {
      if (code.length <= MAX_AUDIT_CODE_LENGTH) {
        return code;
      }
      return code.slice(0, MAX_AUDIT_CODE_LENGTH) + "...[truncated]";
    });
  }

  private sanitizeIp(ip?: string): string | undefined {
    if (!ip) {
      return undefined;
    }
    // Remove port if present
    const ipOnly = ip.split(":")[0];
    // Basic validation
    if (ipOnly.length > 45) {
      return ipOnly.slice(0, 45);
    }
    return ipOnly;
  }

  private truncateUserAgent(userAgent?: string): string | undefined {
    if (!userAgent) {
      return undefined;
    }
    const maxLength = 256;
    if (userAgent.length <= maxLength) {
      return userAgent;
    }
    return userAgent.slice(0, maxLength) + "...";
  }
}
