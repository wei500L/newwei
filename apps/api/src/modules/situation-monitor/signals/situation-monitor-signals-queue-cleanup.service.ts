import { Injectable, OnModuleDestroy } from '@nestjs/common';

interface Closable {
  close: () => Promise<unknown>;
}

@Injectable()
export class SituationMonitorSignalsQueueCleanupService implements OnModuleDestroy {
  private readonly resources = new Set<Closable>();

  track(resource: Closable) {
    this.resources.add(resource);
  }

  async onModuleDestroy() {
    await Promise.allSettled(
      Array.from(this.resources).map(async (resource) => {
        await resource.close();
      }),
    );
    this.resources.clear();
  }
}
