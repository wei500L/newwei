import { Injectable } from "@nestjs/common";
import { CacheService } from "./cache.service";

@Injectable()
export class RateLimiterService {
  constructor(private readonly cache: CacheService) {}

  async consume(key: string, limit: number, windowSeconds: number) {
    const usage = await this.cache.incr(`rate:${key}`, windowSeconds);
    if (usage > limit) {
      return false;
    }
    return true;
  }
}
