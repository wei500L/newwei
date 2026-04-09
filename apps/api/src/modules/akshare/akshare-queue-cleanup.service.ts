import { Injectable, OnModuleDestroy } from "@nestjs/common";

interface Closeable {
  close?: () => Promise<unknown> | void;
}

@Injectable()
export class AkshareQueueCleanupService implements OnModuleDestroy {
  private readonly closeables = new Set<Closeable>();

  track<T extends Closeable>(closeable: T): T {
    this.closeables.add(closeable);
    return closeable;
  }

  async onModuleDestroy() {
    const tasks = [...this.closeables].map(async (entry) => {
      if (typeof entry.close !== "function") {
        return;
      }
      try {
        await entry.close();
      } catch {
        // best-effort cleanup
      }
    });

    this.closeables.clear();
    await Promise.allSettled(tasks);
  }
}
