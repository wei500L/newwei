import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";

import {
  CrawlMediaAssetService,
  type CrawlMediaAccessMode
} from "./crawl-media-asset.service";

const logger = createLogger({ name: "crawl-media-asset-controller" });

@ApiTags("crawl-media-assets")
@Controller("crawl-media-assets")
export class CrawlMediaAssetController {
  constructor(private readonly mediaAssets: CrawlMediaAssetService) {}

  @Public()
  @Get(":assetId/:mode")
  async serveAsset(
    @Param("assetId") assetId: string,
    @Param("mode") modeRaw: string,
    @Query("exp") exp: string | undefined,
    @Query("org") orgId: string | undefined,
    @Query("user") userId: string | undefined,
    @Query("sig") sig: string | undefined,
    @Res() res: Response
  ) {
    const mode = this.normalizeMode(modeRaw);
    if (!mode) {
      throw new NotFoundException("Unsupported crawl media access mode");
    }

    const verify = this.mediaAssets.verifySignedAssetAccess({
      assetId,
      mode,
      expiresAtMs: exp,
      orgId,
      userId,
      signature: sig
    });

    if (!verify.ok) {
      logger.warn(
        {
          assetId,
          mode,
          reason: verify.reason
        },
        "Rejected crawl media asset request"
      );
      throw new BadRequestException(verify.reason ?? "Invalid crawl media signature");
    }

    if (!orgId) {
      throw new BadRequestException("Missing org");
    }

    const payload = await this.mediaAssets.getAssetDeliveryPayload(assetId, mode, { orgId });
    if (!payload) {
      throw new NotFoundException("Crawl media asset not found");
    }

    if (payload.redirectUrl) {
      return res.redirect(payload.redirectUrl);
    }

    if (!payload.data || payload.data.length === 0) {
      logger.error(
        {
          assetId,
          mode
        },
        "Crawl media payload is missing binary data"
      );
      throw new NotFoundException("Crawl media payload is unavailable");
    }

    const disposition =
      mode === "preview" && payload.inlineSafe ? "inline" : "attachment";
    res.setHeader("Content-Type", payload.contentType);
    res.setHeader("Content-Length", String(payload.bytes));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (disposition === "inline") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    }
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${this.escapeFileName(payload.fileName)}"`
    );
    return res.status(200).send(payload.data);
  }

  private normalizeMode(value: string): CrawlMediaAccessMode | null {
    if (value === "preview" || value === "download") {
      return value;
    }
    return null;
  }

  private escapeFileName(value: string) {
    return value.replace(/[\\"]/g, "_");
  }
}
