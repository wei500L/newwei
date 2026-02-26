import { createLogger } from "@modular/utils";
import { PrismaClient } from "@prisma/client";

import {
  buildCanonicalUrlFingerprint,
  resolveQueryParamAllowlist,
} from "../src/modules/crawl/url-fingerprint";

const logger = createLogger({ name: "canonical-url-fingerprint-backfill" });

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
  orgId?: string;
  maxRows?: number;
  useResume: boolean;
  resetResume: boolean;
  resumeKey: string;
}

interface BackfillStats {
  scanned: number;
  changed: number;
  updated: number;
  failed: number;
}

interface StageBackfillResult {
  stats: BackfillStats;
  completed: boolean;
  cursor?: string;
}

type ResumeStage = "crawlResult" | "pipelineJob" | "article";

interface BackfillResumeState {
  version: 1;
  orgId: string | null;
  updatedAt: string;
  cursorByStage: Partial<Record<ResumeStage, string>>;
}

interface ResumeStore {
  settingKey: string;
  getCursor(stage: ResumeStage): string | undefined;
  saveCursor(stage: ResumeStage, cursor: string): Promise<void>;
  clearCursor(stage: ResumeStage): Promise<void>;
  clear(): Promise<void>;
  snapshot(): BackfillResumeState;
}

const DEFAULT_BATCH_SIZE = 500;
const RESUME_SETTING_KEY_PREFIX =
  "script:backfill:canonical-url-fingerprint:resume";
const RESUME_STATE_VERSION = 1;
const RESUME_STATE_DESCRIPTION =
  "Resume cursor state for canonical URL fingerprint backfill script.";
const RESUME_STAGES: ResumeStage[] = ["crawlResult", "pipelineJob", "article"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeResumeKey = (value: string): string =>
  value.trim().replace(/\s+/g, "-").slice(0, 128);

const buildResumeSettingKey = (resumeKey: string): string =>
  `${RESUME_SETTING_KEY_PREFIX}:${resumeKey}`;

const buildDefaultResumeKey = (orgId?: string): string =>
  orgId ? `org-${orgId}` : "all-orgs";

export const parseCliArgsFromArgs = (args: string[]): CliOptions => {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let orgId: string | undefined;
  let maxRows: number | undefined;
  let useResume = true;
  let resetResume = false;
  let resumeKey: string | undefined;

  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (trimmed === "--no-resume") {
      useResume = false;
      continue;
    }
    if (trimmed === "--reset-resume") {
      resetResume = true;
      continue;
    }
    const [key, value] = trimmed.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    if (key === "--batch-size") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        batchSize = Math.max(1, Math.min(2_000, Math.round(parsed)));
      }
      continue;
    }
    if (key === "--org-id") {
      const normalized = value.trim();
      if (normalized.length > 0) {
        orgId = normalized;
      }
      continue;
    }
    if (key === "--max-rows") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxRows = Math.round(parsed);
      }
      continue;
    }
    if (key === "--resume-key") {
      const normalized = normalizeResumeKey(value);
      if (normalized.length > 0) {
        resumeKey = normalized;
      }
      continue;
    }
  }

  if (dryRun) {
    useResume = false;
  }
  if (!useResume) {
    resetResume = false;
  }

  return {
    dryRun,
    batchSize,
    useResume,
    resetResume,
    resumeKey: resumeKey ?? buildDefaultResumeKey(orgId),
    ...(orgId ? { orgId } : {}),
    ...(typeof maxRows === "number" ? { maxRows } : {}),
  };
};

const parseCliArgs = (): CliOptions => parseCliArgsFromArgs(process.argv.slice(2));

const createEmptyResumeState = (orgId?: string): BackfillResumeState => ({
  version: RESUME_STATE_VERSION,
  orgId: orgId ?? null,
  updatedAt: new Date().toISOString(),
  cursorByStage: {},
});

export const parseResumeState = (
  value: unknown,
  orgId?: string,
): BackfillResumeState => {
  const expectedOrgId = orgId ?? null;
  if (!isRecord(value)) {
    return createEmptyResumeState(orgId);
  }

  const storedOrgId =
    typeof value.orgId === "string" && value.orgId.trim().length > 0
      ? value.orgId.trim()
      : null;
  if (storedOrgId !== expectedOrgId) {
    return createEmptyResumeState(orgId);
  }

  const cursorByStage: Partial<Record<ResumeStage, string>> = {};
  const rawCursorByStage = isRecord(value.cursorByStage)
    ? value.cursorByStage
    : undefined;
  if (rawCursorByStage) {
    for (const stage of RESUME_STAGES) {
      const rawCursor = rawCursorByStage[stage];
      if (typeof rawCursor === "string" && rawCursor.trim().length > 0) {
        cursorByStage[stage] = rawCursor;
      }
    }
  }

  return {
    version: RESUME_STATE_VERSION,
    orgId: expectedOrgId,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.length > 0
        ? value.updatedAt
        : new Date().toISOString(),
    cursorByStage,
  };
};

const isCursorNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "P2025") {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    message.toLowerCase().includes("record to search for not found")
  );
};

export const createResumeStore = async (
  prisma: PrismaClient,
  options: CliOptions,
): Promise<ResumeStore | null> => {
  if (!options.useResume) {
    return null;
  }

  const settingKey = buildResumeSettingKey(options.resumeKey);
  if (options.resetResume) {
    await prisma.systemSetting.deleteMany({
      where: { key: settingKey },
    });
    logger.info(
      { resumeKey: options.resumeKey, settingKey },
      "Reset canonical URL fingerprint backfill resume cursor",
    );
  }

  const persisted = await prisma.systemSetting.findUnique({
    where: { key: settingKey },
    select: { value: true },
  });
  const state = parseResumeState(persisted?.value, options.orgId);

  const persistState = async () => {
    await prisma.systemSetting.upsert({
      where: { key: settingKey },
      create: {
        key: settingKey,
        value: state,
        description: RESUME_STATE_DESCRIPTION,
      },
      update: {
        value: state,
        description: RESUME_STATE_DESCRIPTION,
      },
    });
  };

  return {
    settingKey,
    getCursor(stage: ResumeStage) {
      return state.cursorByStage[stage];
    },
    async saveCursor(stage: ResumeStage, cursor: string) {
      if (!cursor) {
        return;
      }
      state.cursorByStage[stage] = cursor;
      state.updatedAt = new Date().toISOString();
      await persistState();
    },
    async clearCursor(stage: ResumeStage) {
      if (!state.cursorByStage[stage]) {
        return;
      }
      delete state.cursorByStage[stage];
      state.updatedAt = new Date().toISOString();
      await persistState();
    },
    async clear() {
      await prisma.systemSetting.deleteMany({
        where: { key: settingKey },
      });
    },
    snapshot() {
      return { ...state, cursorByStage: { ...state.cursorByStage } };
    },
  };
};

const extractAllowlistFromMetadata = (metadata: unknown): string[] | undefined => {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const direct = resolveQueryParamAllowlist(metadata.urlQueryParamAllowlist, []);
  if (direct.length > 0) {
    return direct;
  }

  const newsSourceSeed = isRecord(metadata.newsSourceSeed)
    ? metadata.newsSourceSeed
    : undefined;
  if (newsSourceSeed) {
    const fromSeed = resolveQueryParamAllowlist(newsSourceSeed.queryParamAllowlist, []);
    if (fromSeed.length > 0) {
      return fromSeed;
    }
  }

  const itemPayload = isRecord(metadata.itemPayload) ? metadata.itemPayload : undefined;
  const payloadMetadata =
    itemPayload && isRecord(itemPayload.metadata) ? itemPayload.metadata : undefined;
  if (payloadMetadata) {
    const fromPayload = resolveQueryParamAllowlist(
      payloadMetadata.urlQueryParamAllowlist,
      [],
    );
    if (fromPayload.length > 0) {
      return fromPayload;
    }
  }

  return undefined;
};

const computeNextFingerprint = (url: string, metadata: unknown): string | null => {
  const allowlist = extractAllowlistFromMetadata(metadata);
  const canonical = buildCanonicalUrlFingerprint(url, allowlist);
  return canonical?.fingerprint ?? null;
};

const runBatchedUpdates = async (
  updates: Array<() => Promise<void>>,
  maxConcurrency = 20,
) => {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(maxConcurrency, updates.length) },
    () =>
      (async () => {
        while (index < updates.length) {
          const current = index;
          index += 1;
          const runner = updates[current];
          if (!runner) {
            continue;
          }
          await runner();
        }
      })(),
  );
  await Promise.all(workers);
};

const buildEmptyStats = (): BackfillStats => ({
  scanned: 0,
  changed: 0,
  updated: 0,
  failed: 0,
});

const shouldStopAtLimit = (stats: BackfillStats, maxRows?: number): boolean =>
  typeof maxRows === "number" && maxRows > 0 && stats.scanned >= maxRows;

export const backfillCrawlResultFingerprints = async (
  prisma: PrismaClient,
  options: CliOptions,
  resumeStore: ResumeStore | null,
): Promise<StageBackfillResult> => {
  const stats = buildEmptyStats();
  let cursor = resumeStore?.getCursor("crawlResult");
  let completed = false;
  let resumeAfterCursor: string | undefined;

  while (true) {
    if (shouldStopAtLimit(stats, options.maxRows)) {
      break;
    }
    let rows: Array<{
      id: string;
      sourceUrl: string;
      sourceUrlFingerprint: string | null;
      metadata: unknown;
    }>;
    try {
      rows = await prisma.crawlResult.findMany({
        where: {
          ...(options.orgId ? { orgId: options.orgId } : {}),
          ...(resumeAfterCursor ? { id: { gt: resumeAfterCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: options.batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          sourceUrl: true,
          sourceUrlFingerprint: true,
          metadata: true,
        },
      });
    } catch (error) {
      if (cursor && isCursorNotFoundError(error)) {
        const staleCursor = cursor;
        cursor = undefined;
        resumeAfterCursor = staleCursor;
        await resumeStore?.clearCursor("crawlResult");
        logger.warn(
          { staleCursor },
          "crawlResult resume cursor not found; fallback to id > cursor window",
        );
        continue;
      }
      throw error;
    }

    if (rows.length === 0) {
      completed = true;
      break;
    }

    const updateJobs: Array<() => Promise<void>> = [];
    let lastProcessedCursor: string | undefined;
    for (const row of rows) {
      if (shouldStopAtLimit(stats, options.maxRows)) {
        break;
      }
      lastProcessedCursor = row.id;
      stats.scanned += 1;
      const nextFingerprint = computeNextFingerprint(row.sourceUrl, row.metadata);
      if (!nextFingerprint || row.sourceUrlFingerprint === nextFingerprint) {
        continue;
      }

      stats.changed += 1;
      if (options.dryRun) {
        continue;
      }

      updateJobs.push(async () => {
        try {
          await prisma.crawlResult.update({
            where: { id: row.id },
            data: { sourceUrlFingerprint: nextFingerprint },
          });
          stats.updated += 1;
        } catch (error) {
          stats.failed += 1;
          logger.warn(
            { err: error, id: row.id },
            "Failed to update crawlResult sourceUrlFingerprint",
          );
        }
      });
    }

    if (!options.dryRun && updateJobs.length > 0) {
      await runBatchedUpdates(updateJobs);
    }

    if (lastProcessedCursor) {
      cursor = lastProcessedCursor;
      resumeAfterCursor = undefined;
      if (resumeStore) {
        await resumeStore.saveCursor("crawlResult", lastProcessedCursor);
      }
    }
  }

  return { stats, completed, cursor };
};

export const backfillPipelineJobFingerprints = async (
  prisma: PrismaClient,
  options: CliOptions,
  resumeStore: ResumeStore | null,
): Promise<StageBackfillResult> => {
  const stats = buildEmptyStats();
  let cursor = resumeStore?.getCursor("pipelineJob");
  let completed = false;
  let resumeAfterCursor: string | undefined;

  while (true) {
    if (shouldStopAtLimit(stats, options.maxRows)) {
      break;
    }
    let rows: Array<{
      id: string;
      url: string;
      urlFingerprint: string | null;
      metadata: unknown;
    }>;
    try {
      rows = await prisma.pipelineJob.findMany({
        where: {
          ...(options.orgId ? { orgId: options.orgId } : {}),
          ...(resumeAfterCursor ? { id: { gt: resumeAfterCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: options.batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          url: true,
          urlFingerprint: true,
          metadata: true,
        },
      });
    } catch (error) {
      if (cursor && isCursorNotFoundError(error)) {
        const staleCursor = cursor;
        cursor = undefined;
        resumeAfterCursor = staleCursor;
        await resumeStore?.clearCursor("pipelineJob");
        logger.warn(
          { staleCursor },
          "pipelineJob resume cursor not found; fallback to id > cursor window",
        );
        continue;
      }
      throw error;
    }

    if (rows.length === 0) {
      completed = true;
      break;
    }

    const updateJobs: Array<() => Promise<void>> = [];
    let lastProcessedCursor: string | undefined;
    for (const row of rows) {
      if (shouldStopAtLimit(stats, options.maxRows)) {
        break;
      }
      lastProcessedCursor = row.id;
      stats.scanned += 1;
      const nextFingerprint = computeNextFingerprint(row.url, row.metadata);
      if (!nextFingerprint || row.urlFingerprint === nextFingerprint) {
        continue;
      }

      stats.changed += 1;
      if (options.dryRun) {
        continue;
      }

      updateJobs.push(async () => {
        try {
          await prisma.pipelineJob.update({
            where: { id: row.id },
            data: { urlFingerprint: nextFingerprint },
          });
          stats.updated += 1;
        } catch (error) {
          stats.failed += 1;
          logger.warn(
            { err: error, id: row.id },
            "Failed to update pipelineJob urlFingerprint",
          );
        }
      });
    }

    if (!options.dryRun && updateJobs.length > 0) {
      await runBatchedUpdates(updateJobs);
    }

    if (lastProcessedCursor) {
      cursor = lastProcessedCursor;
      resumeAfterCursor = undefined;
      if (resumeStore) {
        await resumeStore.saveCursor("pipelineJob", lastProcessedCursor);
      }
    }
  }

  return { stats, completed, cursor };
};

export const backfillArticleFingerprints = async (
  prisma: PrismaClient,
  options: CliOptions,
  resumeStore: ResumeStore | null,
): Promise<StageBackfillResult> => {
  const stats = buildEmptyStats();
  let cursor = resumeStore?.getCursor("article");
  let completed = false;
  let resumeAfterCursor: string | undefined;

  while (true) {
    if (shouldStopAtLimit(stats, options.maxRows)) {
      break;
    }
    let rows: Array<{
      id: string;
      url: string;
      urlFingerprint: string | null;
      metadata: unknown;
    }>;
    try {
      rows = await prisma.article.findMany({
        where: {
          ...(options.orgId ? { orgId: options.orgId } : {}),
          ...(resumeAfterCursor ? { id: { gt: resumeAfterCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: options.batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          url: true,
          urlFingerprint: true,
          metadata: true,
        },
      });
    } catch (error) {
      if (cursor && isCursorNotFoundError(error)) {
        const staleCursor = cursor;
        cursor = undefined;
        resumeAfterCursor = staleCursor;
        await resumeStore?.clearCursor("article");
        logger.warn(
          { staleCursor },
          "article resume cursor not found; fallback to id > cursor window",
        );
        continue;
      }
      throw error;
    }

    if (rows.length === 0) {
      completed = true;
      break;
    }

    const updateJobs: Array<() => Promise<void>> = [];
    let lastProcessedCursor: string | undefined;
    for (const row of rows) {
      if (shouldStopAtLimit(stats, options.maxRows)) {
        break;
      }
      lastProcessedCursor = row.id;
      stats.scanned += 1;
      const nextFingerprint = computeNextFingerprint(row.url, row.metadata);
      if (!nextFingerprint || row.urlFingerprint === nextFingerprint) {
        continue;
      }

      stats.changed += 1;
      if (options.dryRun) {
        continue;
      }

      updateJobs.push(async () => {
        try {
          await prisma.article.update({
            where: { id: row.id },
            data: { urlFingerprint: nextFingerprint },
          });
          stats.updated += 1;
        } catch (error) {
          stats.failed += 1;
          logger.warn(
            { err: error, id: row.id },
            "Failed to update article urlFingerprint",
          );
        }
      });
    }

    if (!options.dryRun && updateJobs.length > 0) {
      await runBatchedUpdates(updateJobs);
    }

    if (lastProcessedCursor) {
      cursor = lastProcessedCursor;
      resumeAfterCursor = undefined;
      if (resumeStore) {
        await resumeStore.saveCursor("article", lastProcessedCursor);
      }
    }
  }

  return { stats, completed, cursor };
};

const main = async () => {
  const options = parseCliArgs();
  const resumeSettingKey = options.useResume
    ? buildResumeSettingKey(options.resumeKey)
    : null;
  logger.info(
    {
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      orgId: options.orgId ?? null,
      maxRows: options.maxRows ?? null,
      useResume: options.useResume,
      resumeKey: options.useResume ? options.resumeKey : null,
      resumeSettingKey,
    },
    "Starting canonical URL fingerprint backfill",
  );

  const prisma = new PrismaClient();
  try {
    const resumeStore = await createResumeStore(prisma, options);
    if (resumeStore) {
      logger.info(
        {
          resumeSettingKey: resumeStore.settingKey,
          resumeState: resumeStore.snapshot(),
        },
        "Loaded canonical URL fingerprint backfill resume cursor",
      );
    }

    const crawlResultResult = await backfillCrawlResultFingerprints(
      prisma,
      options,
      resumeStore,
    );
    logger.info(
      {
        ...crawlResultResult.stats,
        completed: crawlResultResult.completed,
        cursor: crawlResultResult.cursor ?? null,
      },
      "CrawlResult fingerprint backfill completed",
    );

    const pipelineJobResult = await backfillPipelineJobFingerprints(
      prisma,
      options,
      resumeStore,
    );
    logger.info(
      {
        ...pipelineJobResult.stats,
        completed: pipelineJobResult.completed,
        cursor: pipelineJobResult.cursor ?? null,
      },
      "PipelineJob fingerprint backfill completed",
    );

    const articleResult = await backfillArticleFingerprints(
      prisma,
      options,
      resumeStore,
    );
    logger.info(
      {
        ...articleResult.stats,
        completed: articleResult.completed,
        cursor: articleResult.cursor ?? null,
      },
      "Article fingerprint backfill completed",
    );

    const fullyCompleted =
      crawlResultResult.completed &&
      pipelineJobResult.completed &&
      articleResult.completed;
    if (resumeStore) {
      if (fullyCompleted) {
        await resumeStore.clear();
        logger.info(
          { resumeSettingKey: resumeStore.settingKey },
          "Cleared canonical URL fingerprint backfill resume cursor",
        );
      } else {
        logger.info(
          {
            resumeSettingKey: resumeStore.settingKey,
            resumeState: resumeStore.snapshot(),
          },
          "Backfill finished partially; resume cursor preserved",
        );
      }
    }

    logger.info(
      {
        dryRun: options.dryRun,
        useResume: options.useResume,
        resumeKey: options.useResume ? options.resumeKey : null,
        resumeSettingKey,
        crawlResult: crawlResultResult.stats,
        pipelineJob: pipelineJobResult.stats,
        article: articleResult.stats,
        fullyCompleted,
      },
      "Canonical URL fingerprint backfill finished",
    );
  } finally {
    await prisma.$disconnect();
  }
};

export const __testing = {
  buildResumeSettingKey,
  buildDefaultResumeKey,
  isCursorNotFoundError,
};

if (process.env.NODE_ENV !== "test") {
  void main().catch((error) => {
    logger.error({ err: error }, "Canonical URL fingerprint backfill failed");
    process.exitCode = 1;
  });
}
