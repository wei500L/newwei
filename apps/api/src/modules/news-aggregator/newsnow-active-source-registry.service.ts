import { Injectable } from "@nestjs/common";

interface ActiveSourceSession {
  orgId: string;
  sourceIds: string[];
}

@Injectable()
export class NewsnowActiveSourceRegistryService {
  private readonly sessions = new Map<string, ActiveSourceSession>();

  setActiveSources(input: {
    socketId: string;
    orgId: string;
    sourceIds: string[];
  }) {
    const socketId = input.socketId.trim();
    const orgId = input.orgId.trim();
    const sourceIds = Array.from(
      new Set(
        input.sourceIds
          .map((sourceId) => sourceId.trim())
          .filter(Boolean),
      ),
    );

    if (!socketId) {
      return;
    }

    if (!orgId || sourceIds.length === 0) {
      this.sessions.delete(socketId);
      return;
    }

    this.sessions.set(socketId, {
      orgId,
      sourceIds,
    });
  }

  removeSocket(socketId: string) {
    this.sessions.delete(socketId.trim());
  }

  getActiveSourceIdsByOrg() {
    const sourceIdsByOrg = new Map<string, Set<string>>();

    for (const session of this.sessions.values()) {
      const current = sourceIdsByOrg.get(session.orgId) ?? new Set<string>();
      session.sourceIds.forEach((sourceId) => current.add(sourceId));
      sourceIdsByOrg.set(session.orgId, current);
    }

    return new Map(
      Array.from(sourceIdsByOrg.entries()).map(([orgId, sourceIds]) => [
        orgId,
        Array.from(sourceIds),
      ]),
    );
  }

  getOrgIdsForSource(sourceId: string) {
    const normalizedSourceId = sourceId.trim();
    if (!normalizedSourceId) {
      return [];
    }

    const orgIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.sourceIds.includes(normalizedSourceId)) {
        orgIds.add(session.orgId);
      }
    }

    return Array.from(orgIds);
  }

  getAllActiveSourceIds() {
    return Array.from(
      new Set(
        Array.from(this.sessions.values()).flatMap((session) => session.sourceIds),
      ),
    );
  }

  clear() {
    this.sessions.clear();
  }
}
