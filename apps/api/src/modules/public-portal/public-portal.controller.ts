import { Controller, Get, Header, NotFoundException, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";

import { PublicPortalService } from "./public-portal.service";

const CACHE_CONTROL_HEADER = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

@ApiTags("public-portal")
@Controller("public-portal")
export class PublicPortalController {
  constructor(private readonly portal: PublicPortalService) {}

  @Public()
  @Get("home")
  @Header("Cache-Control", CACHE_CONTROL_HEADER)
  async getHome() {
    return this.portal.getHome();
  }

  @Public()
  @Get("channels/:topic")
  @Header("Cache-Control", CACHE_CONTROL_HEADER)
  async getChannel(@Param("topic") topic: string) {
    const payload = await this.portal.getChannel(topic);
    if (!payload) {
      throw new NotFoundException("Channel not found");
    }
    return payload;
  }

  @Public()
  @Get("stories/id/:id")
  @Header("Cache-Control", CACHE_CONTROL_HEADER)
  async getStoryById(@Param("id") id: string) {
    const payload = await this.portal.getStoryById(id);
    if (!payload) {
      throw new NotFoundException("Story not found");
    }
    return payload;
  }

  @Public()
  @Get("stories/slug/:slug")
  @Header("Cache-Control", CACHE_CONTROL_HEADER)
  async getStoryBySlug(@Param("slug") slug: string) {
    const payload = await this.portal.getStoryBySlug(slug);
    if (!payload) {
      throw new NotFoundException("Story not found");
    }
    return payload;
  }
}
