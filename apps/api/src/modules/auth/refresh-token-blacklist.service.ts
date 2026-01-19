import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

@Injectable()
export class RefreshTokenBlacklistService {
  private readonly prefix = "refresh-token:blacklist";

  constructor(private readonly cache: CacheService) {}

  private getKey(tokenId: string) {
    return `${this.prefix}:${tokenId}`;
  }

  async add(tokenId: string, ttlSeconds: number) {
    if (!tokenId || ttlSeconds <= 0) {
      return;
    }
    await this.cache.set(this.getKey(tokenId), true, ttlSeconds);
  }

  async has(tokenId: string) {
    if (!tokenId) {
      return false;
    }
    const entry = await this.cache.get<boolean>(this.getKey(tokenId));
    return Boolean(entry);
  }
}

