import { Controller, Get, HttpException, Logger, Post, ServiceUnavailableException } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AxiosError } from "axios";
import { lastValueFrom } from "rxjs";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";

interface AkshareGatewayVersionResponse {
  akshareVersion: string;
  pythonVersion: string;
}

interface AkshareGatewayUpgradeAcceptedResponse {
  status: "accepted";
  requestId: string;
  beforeVersion: string;
}

interface AkshareGatewayUpgradeStatusResponse {
  inProgress: boolean;
  stage: "idle" | "queued" | "running" | "restarting" | "failed";
  requestId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  restartScheduledAt: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  error: string | null;
  pipStdout: string | null;
  pipStderr: string | null;
  pid?: number;
}

@ApiTags("akshare")
@ApiBearerAuth()
@Controller("admin/akshare")
export class AdminAkshareController {
  private readonly logger = new Logger(AdminAkshareController.name);

  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService,
    private readonly prisma: PrismaService
  ) {}

  private get gatewayBaseUrl() {
    return this.env.akshareConfig.baseUrl.replace(/\/$/, "");
  }

  private get adminToken() {
    return this.env.akshareAdminToken;
  }

  private handleGatewayError(error: unknown): never {
    const axiosError = error as AxiosError | undefined;
    const status = axiosError?.response?.status;
    const data = axiosError?.response?.data;
    if (typeof status === "number") {
      throw new HttpException(data ?? "Akshare gateway request failed", status);
    }
    throw error;
  }

  @Get("version")
  @Permissions("settings.manage")
  async version(): Promise<AkshareGatewayVersionResponse> {
    try {
      const response = await lastValueFrom(
        this.http.get<AkshareGatewayVersionResponse>(`${this.gatewayBaseUrl}/version`, {
          timeout: 10_000
        })
      );
      return response.data;
    } catch (error) {
      this.handleGatewayError(error);
    }
  }

  @Get("status")
  @Permissions("settings.manage")
  async status(): Promise<AkshareGatewayUpgradeStatusResponse> {
    if (!this.adminToken) {
      throw new ServiceUnavailableException(
        "AKSHARE_ADMIN_TOKEN is not configured; akshare gateway upgrade status is disabled"
      );
    }

    try {
      const response = await lastValueFrom(
        this.http.get<AkshareGatewayUpgradeStatusResponse>(`${this.gatewayBaseUrl}/admin/status`, {
          headers: { "x-akshare-admin-token": this.adminToken },
          timeout: 10_000
        })
      );
      return response.data;
    } catch (error) {
      this.handleGatewayError(error);
    }
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private truncateText(value: unknown, max = 4000) {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    if (text.length <= max) {
      return text;
    }
    return text.slice(0, max) + `…(truncated, ${text.length} chars)`;
  }

  private async watchUpgradeCompletion(args: { orgId: string; actorId: string; requestId: string; beforeVersion: string }) {
    const startedAt = Date.now();
    const deadline = startedAt + 15 * 60_000;
    let sawRequestId = false;

    while (Date.now() < deadline) {
      try {
        const status = await this.status();
        if (status.requestId !== args.requestId) {
          if (sawRequestId) {
            try {
              const version = await this.version();
              if (version.akshareVersion && version.akshareVersion !== args.beforeVersion) {
                try {
                  await writeAuditLogBestEffort(this.prisma, {
                    data: {
                      orgId: args.orgId,
                      actorId: args.actorId,
                      resource: "akshare_gateway",
                      action: "upgrade_succeeded",
                      metadata: {
                        requestId: args.requestId,
                        beforeVersion: args.beforeVersion,
                        afterVersion: version.akshareVersion,
                        durationMs: Date.now() - startedAt,
                        note: "Observed version change after gateway restart; upgrade status state was reset"
                      }
                    }
                  });
                } catch (error) {
                  this.logger.warn(
                    `Failed to write audit log for akshare upgrade success requestId=${args.requestId}: ${
                      (error as Error)?.message ?? error
                    }`
                  );
                }
                return;
              }
            } catch (error) {
              this.logger.warn(
                `Failed to verify akshare version after restart requestId=${args.requestId}: ${
                  (error as Error)?.message ?? error
                }`
              );
            }
          }

          await this.sleep(2_000);
          continue;
        }

        sawRequestId = true;

        if (status.stage === "failed") {
          try {
            await writeAuditLogBestEffort(this.prisma, {
              data: {
                orgId: args.orgId,
                actorId: args.actorId,
                resource: "akshare_gateway",
                action: "upgrade_failed",
                metadata: {
                  requestId: args.requestId,
                  beforeVersion: args.beforeVersion,
                  error: status.error,
                  durationMs: Date.now() - startedAt,
                  pipStdout: this.truncateText(status.pipStdout),
                  pipStderr: this.truncateText(status.pipStderr)
                }
              }
            });
          } catch (error) {
            this.logger.warn(
              `Failed to write audit log for akshare upgrade failure requestId=${args.requestId}: ${
                (error as Error)?.message ?? error
              }`
            );
          }
          return;
        }

        if (status.stage === "restarting") {
          try {
            await writeAuditLogBestEffort(this.prisma, {
              data: {
                orgId: args.orgId,
                actorId: args.actorId,
                resource: "akshare_gateway",
                action: "upgrade_succeeded",
                metadata: {
                  requestId: args.requestId,
                  beforeVersion: args.beforeVersion,
                  afterVersion: status.afterVersion,
                  durationMs: Date.now() - startedAt,
                  pipStdout: this.truncateText(status.pipStdout),
                  pipStderr: this.truncateText(status.pipStderr)
                }
              }
            });
          } catch (error) {
            this.logger.warn(
              `Failed to write audit log for akshare upgrade success requestId=${args.requestId}: ${
                (error as Error)?.message ?? error
              }`
            );
          }
          return;
        }
      } catch (error) {
        this.logger.warn(`Failed to poll akshare upgrade status: ${(error as Error)?.message ?? error}`);
      }

      await this.sleep(2_000);
    }

    this.logger.warn(`Timed out waiting for akshare upgrade completion requestId=${args.requestId}`);
  }

  @Post("upgrade")
  @Permissions("settings.manage")
  async upgrade(@CurrentUser() user: AuthenticatedUser): Promise<AkshareGatewayUpgradeAcceptedResponse> {
    if (!this.adminToken) {
      throw new ServiceUnavailableException(
        "AKSHARE_ADMIN_TOKEN is not configured; akshare gateway upgrade is disabled"
      );
    }

    let beforeVersion = "unknown";
    try {
      beforeVersion = (await this.version()).akshareVersion || beforeVersion;
    } catch (error) {
      this.logger.warn(`Failed to fetch akshare version before upgrade: ${(error as Error)?.message ?? error}`);
    }

    try {
      const response = await lastValueFrom(
        this.http.post<AkshareGatewayUpgradeAcceptedResponse>(
          `${this.gatewayBaseUrl}/admin/upgrade`,
          {},
          {
            headers: { "x-akshare-admin-token": this.adminToken },
            timeout: 15_000
          }
        )
      );

      const payload = response.data;
      this.logger.log(`Akshare upgrade requested requestId=${payload.requestId} before=${beforeVersion}`);

      void writeAuditLogBestEffort(this.prisma, {
        data: {
          orgId: user.orgId,
          actorId: user.id,
          resource: "akshare_gateway",
          action: "upgrade_requested",
          metadata: {
            requestId: payload.requestId,
            beforeVersion: beforeVersion,
            gatewayBaseUrl: this.gatewayBaseUrl
          }
        }
      }).catch((error) => {
        this.logger.warn(
          `Failed to write audit log for akshare upgrade requestId=${payload.requestId}: ${
            (error as Error)?.message ?? error
          }`
        );
      });

      void this.watchUpgradeCompletion({
        orgId: user.orgId,
        actorId: user.id,
        requestId: payload.requestId,
        beforeVersion
      });

      return payload;
    } catch (error) {
      this.handleGatewayError(error);
    }
  }
}
