import { BadRequestException, Injectable } from '@nestjs/common';
import { NewsSourceType, Prisma } from '@prisma/client';
import { XMLParser } from 'fast-xml-parser';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { validateSsrfUrlAsync } from '../../common/validators/ssrf-url.validator';
import { PrismaService } from '../config/prisma.service';

import {
  findNewsSourceOpmlPreset,
  NEWS_SOURCE_OPML_PRESETS,
} from './news-source-opml-presets';

export interface NewsSourceOpmlPresetSummary {
  id: string;
  name: string;
  description: string;
  defaultLanguage: string;
  entryCount: number;
}

export interface NewsSourceOpmlPreviewEntry {
  name: string;
  url: string;
  feedUrl: string;
  language: string;
  group: string | null;
  enabled: boolean;
  valid: boolean;
  alreadyExists: boolean;
  errors: string[];
}

export interface NewsSourceOpmlPreviewResponse {
  presetId: string | null;
  title: string | null;
  entries: NewsSourceOpmlPreviewEntry[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
    enabled: number;
  };
}

export interface ImportNewsSourceOpmlEntryInput {
  name: string;
  url: string;
  feedUrl: string;
  language?: string;
  enabled?: boolean;
  siteType?: NewsSourceType;
  group?: string | null;
}

export interface ImportNewsSourceOpmlReport {
  summary: {
    total: number;
    enabled: number;
    created: number;
    skipped: number;
    failed: number;
  };
  created: { id: string; name: string; url: string }[];
  skipped: { name: string; url: string; reason: string }[];
  failed: { name: string; url: string; error: string }[];
}

interface ParsedOpmlOutline {
  type?: unknown;
  text?: unknown;
  title?: unknown;
  xmlUrl?: unknown;
  htmlUrl?: unknown;
  outline?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeUrlForStorage(raw: string): string {
  // Normalize enough to avoid trivial dupes (root trailing slash, hash).
  const parsed = new URL(raw);
  parsed.hash = '';

  if (parsed.pathname === '/' && !parsed.search) {
    return parsed.origin;
  }

  if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

function buildUrlEquivalenceCandidates(raw: string): string[] {
  // Used only for duplicate detection. Avoids creating duplicates due to trailing slashes.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [raw];
  }
  parsed.hash = '';

  const candidates = new Set<string>();

  const base = parsed.toString();
  candidates.add(base);

  // Toggle trailing slash on pathname for common homepage/listing URLs.
  if (parsed.pathname === '/' && !parsed.search) {
    candidates.add(parsed.origin);
    candidates.add(`${parsed.origin}/`);
  } else {
    const pathname = parsed.pathname;
    if (pathname.endsWith('/') && pathname !== '/') {
      const without = new URL(parsed.toString());
      without.pathname = pathname.slice(0, -1);
      candidates.add(without.toString());
    } else if (!pathname.endsWith('/')) {
      const withSlash = new URL(parsed.toString());
      withSlash.pathname = `${pathname}/`;
      candidates.add(withSlash.toString());
    }
  }

  return Array.from(candidates);
}

@Injectable()
export class NewsSourceOpmlService {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    allowBooleanAttributes: true,
    trimValues: true,
  });

  constructor(private readonly prisma: PrismaService) {}

  listPresets(): NewsSourceOpmlPresetSummary[] {
    return NEWS_SOURCE_OPML_PRESETS.map((preset) => {
      const parsed = this.parseOpml(preset.opml);
      return {
        id: preset.id,
        name: preset.name,
        description: preset.description,
        defaultLanguage: preset.defaultLanguage,
        entryCount: parsed.entries.length,
      };
    });
  }

  async preview(options: {
    orgId: string;
    presetId?: string | null;
    opmlContent?: string | null;
    defaultLanguage?: string | null;
  }): Promise<NewsSourceOpmlPreviewResponse> {
    const presetId = normalizeOptionalString(options.presetId) ?? null;
    const opmlContent = normalizeOptionalString(options.opmlContent);
    if (!presetId && !opmlContent) {
      throw new BadRequestException('presetId or opmlContent is required');
    }

    const preset = presetId ? findNewsSourceOpmlPreset(presetId) : null;
    if (presetId && !preset) {
      throw new BadRequestException('Unknown OPML preset');
    }

    const defaultLanguage = this.normalizeLanguage(
      options.defaultLanguage ?? preset?.defaultLanguage ?? 'zh',
    );
    const resolvedOpml = opmlContent ?? preset?.opml ?? null;

    const parsed = resolvedOpml
      ? this.parseOpml(resolvedOpml)
      : {
          title: null,
          entries: [],
        };

    const normalizedEntries = await Promise.all(
      parsed.entries.map(async (entry) => {
        const errors: string[] = [];

        const name = entry.name;
        const rawUrl = entry.url;
        const rawFeedUrl = entry.feedUrl;

        const url = await this.normalizeAndValidateSiteUrl(rawUrl, errors);
        const feedUrl = await this.normalizeAndValidateFeedUrl(
          rawFeedUrl,
          errors,
        );

        const valid = Boolean(url) && Boolean(feedUrl) && errors.length === 0;

        return {
          name,
          url: url ?? rawUrl,
          feedUrl: feedUrl ?? rawFeedUrl,
          language: defaultLanguage,
          group: entry.group ?? null,
          enabled: valid,
          valid,
          alreadyExists: false,
          errors,
        } satisfies NewsSourceOpmlPreviewEntry;
      }),
    );

    // Dedupe: keep first occurrence by URL.
    const uniqueEntries: NewsSourceOpmlPreviewEntry[] = [];
    const seenUrls = new Set<string>();
    for (const entry of normalizedEntries) {
      const key = entry.url;
      if (seenUrls.has(key)) {
        continue;
      }
      seenUrls.add(key);
      uniqueEntries.push(entry);
    }

    const existingUrlSet = await this.findExistingSourceUrlSet(
      options.orgId,
      uniqueEntries.filter((entry) => entry.valid).map((entry) => entry.url),
    );

    for (const entry of uniqueEntries) {
      if (!entry.valid) {
        entry.enabled = false;
        continue;
      }
      const candidates = buildUrlEquivalenceCandidates(entry.url);
      const alreadyExists = candidates.some((candidate) =>
        existingUrlSet.has(candidate),
      );
      entry.alreadyExists = alreadyExists;
      if (alreadyExists) {
        entry.enabled = false;
        entry.errors.push('News source already exists');
      }
    }

    const summary = {
      total: uniqueEntries.length,
      valid: uniqueEntries.filter((entry) => entry.valid).length,
      invalid: uniqueEntries.filter((entry) => !entry.valid).length,
      duplicates: uniqueEntries.filter((entry) => entry.alreadyExists).length,
      enabled: uniqueEntries.filter((entry) => entry.enabled).length,
    };

    return {
      presetId: preset?.id ?? null,
      title: parsed.title,
      entries: uniqueEntries,
      summary,
    };
  }

  async import(options: {
    orgId: string;
    entries: ImportNewsSourceOpmlEntryInput[];
    conflictPolicy?: 'skip' | null;
    runtimeProfile?: 'steady' | null;
  }): Promise<ImportNewsSourceOpmlReport> {
    const conflictPolicy = options.conflictPolicy ?? 'skip';
    if (conflictPolicy !== 'skip') {
      throw new Error('Only conflictPolicy=skip is supported');
    }

    const runtimeProfile = options.runtimeProfile ?? 'steady';
    if (runtimeProfile !== 'steady') {
      throw new Error('Only runtimeProfile=steady is supported');
    }

    const entries = Array.isArray(options.entries) ? options.entries : [];

    const normalized = await Promise.all(
      entries.map(async (entry) => {
        const errors: string[] = [];

        const name = normalizeOptionalString(entry?.name) ?? '';
        const urlRaw = normalizeOptionalString(entry?.url) ?? '';
        const feedUrlRaw = normalizeOptionalString(entry?.feedUrl) ?? '';

        const url = await this.normalizeAndValidateSiteUrl(urlRaw, errors);
        const feedUrl = await this.normalizeAndValidateFeedUrl(
          feedUrlRaw,
          errors,
        );
        const language = this.normalizeLanguage(entry?.language);
        const enabled = entry?.enabled !== false;
        const siteType = entry?.siteType ?? NewsSourceType.general;
        const group = normalizeOptionalString(entry?.group) ?? null;

        const valid =
          Boolean(name) &&
          Boolean(url) &&
          Boolean(feedUrl) &&
          errors.length === 0;

        return {
          name: name || urlRaw,
          url: url ?? urlRaw,
          feedUrl: feedUrl ?? feedUrlRaw,
          language,
          enabled,
          valid,
          siteType,
          group,
          errors,
        };
      }),
    );

    const enabled = normalized.filter((entry) => entry.enabled);

    const candidateUrls = enabled
      .filter((entry) => entry.valid)
      .map((entry) => entry.url);

    const existingUrlSet = await this.findExistingSourceUrlSet(
      options.orgId,
      candidateUrls,
    );

    const report: ImportNewsSourceOpmlReport = {
      summary: {
        total: normalized.length,
        enabled: enabled.length,
        created: 0,
        skipped: 0,
        failed: 0,
      },
      created: [],
      skipped: [],
      failed: [],
    };

    for (const entry of enabled) {
      if (!entry.valid) {
        report.failed.push({
          name: entry.name,
          url: entry.url,
          error:
            entry.errors.length > 0
              ? entry.errors.join('; ')
              : 'Invalid entry',
        });
        continue;
      }

      const dupCandidates = buildUrlEquivalenceCandidates(entry.url);
      if (dupCandidates.some((candidate) => existingUrlSet.has(candidate))) {
        report.skipped.push({
          name: entry.name,
          url: entry.url,
          reason: 'duplicate',
        });
        continue;
      }

      try {
        const created = await this.prisma.newsSource.create({
          data: {
            orgId: options.orgId,
            name: entry.name,
            url: entry.url,
            siteType: entry.siteType,
            language: entry.language,
            crawlTemplateId: null,
            frequencySeconds: 3600,
            priority: 0,
            isActive: true,
            config: toPrismaJsonValue(this.buildDefaultRssSeedConfig(entry.feedUrl)),
            group: normalizeOptionalString(entry.group) ?? null,
            nextRunAt: new Date(),
          },
          select: { id: true, name: true, url: true },
        });
        report.created.push(created);
        report.summary.created += 1;

        // Mark both variants as existing for subsequent entries.
        for (const candidate of buildUrlEquivalenceCandidates(created.url)) {
          existingUrlSet.add(candidate);
        }
      } catch (error) {
        const conflict = this.isUniqueUrlConflict(error);
        if (conflict) {
          report.skipped.push({
            name: entry.name,
            url: entry.url,
            reason: 'duplicate',
          });
          report.summary.skipped += 1;
          continue;
        }
        report.failed.push({
          name: entry.name,
          url: entry.url,
          error: error instanceof Error ? error.message : String(error),
        });
        report.summary.failed += 1;
      }
    }

    report.summary.skipped = report.skipped.length;
    report.summary.failed = report.failed.length;

    return report;
  }

  private parseOpml(opml: string): {
    title: string | null;
    entries: { name: string; url: string; feedUrl: string; group: string | null }[];
  } {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = this.parser.parse(opml) as Record<string, unknown>;
    } catch {
      return { title: null, entries: [] };
    }

    const opmlNode = isRecord(parsed?.opml) ? (parsed.opml as Record<string, unknown>) : parsed;

    const head = isRecord(opmlNode?.head) ? (opmlNode.head as Record<string, unknown>) : null;
    const title = normalizeOptionalString(head?.title) ?? null;

    const body = isRecord(opmlNode?.body) ? (opmlNode.body as Record<string, unknown>) : null;
    const outlines = body?.outline;

    const collected: { outline: ParsedOpmlOutline; group: string | null }[] = [];
    const walk = (node: unknown, parentGroup: string | null = null) => {
      if (!node) {
        return;
      }
      if (Array.isArray(node)) {
        for (const entry of node) {
          walk(entry, parentGroup);
        }
        return;
      }
      if (!isRecord(node)) {
        return;
      }

      const outline = node as ParsedOpmlOutline;
      const typeRaw = normalizeOptionalString(outline.type);
      const xmlUrl = normalizeOptionalString(outline.xmlUrl);
      const htmlUrl = normalizeOptionalString(outline.htmlUrl);

      const type = typeRaw ? typeRaw.toLowerCase() : '';
      const isFeed = type === 'rss' || Boolean(xmlUrl);
      const label =
        normalizeOptionalString(outline.text) ??
        normalizeOptionalString(outline.title) ??
        null;
      if (isFeed && (xmlUrl || htmlUrl)) {
        collected.push({ outline, group: parentGroup });
      }
      const nextGroup = !isFeed && label ? label : parentGroup;

      if ('outline' in node) {
        walk((node as ParsedOpmlOutline).outline, nextGroup);
      }
    };

    walk(outlines);

    const entries = collected
      .map((item) => {
        const name =
          normalizeOptionalString(item.outline.text) ??
          normalizeOptionalString(item.outline.title) ??
          '';
        const feedUrl = normalizeOptionalString(item.outline.xmlUrl) ?? '';
        const url = normalizeOptionalString(item.outline.htmlUrl) ?? '';
        return {
          name: name || url || feedUrl,
          url,
          feedUrl,
          group: item.group ?? null,
        };
      })
      .filter((entry) => entry.url.length > 0 || entry.feedUrl.length > 0);

    return { title, entries };
  }

  private normalizeLanguage(value: unknown): string {
    const raw = normalizeOptionalString(value);
    if (!raw) {
      return 'zh';
    }
    const lower = raw.toLowerCase();
    if (lower.startsWith('zh')) {
      return 'zh';
    }
    if (lower.startsWith('en')) {
      return 'en';
    }
    return lower.length <= 12 ? lower : 'zh';
  }

  // Defense in depth beyond the DTO: imported entries are fetched server-side
  // (feed/site discovery), so reject internal targets even for programmatic
  // callers that bypass DTO validation.
  private async normalizeAndValidateSiteUrl(raw: string, errors: string[]): Promise<string | null> {
    const trimmed = raw.trim();
    if (!trimmed) {
      errors.push('Missing site URL (htmlUrl)');
      return null;
    }
    if (!isHttpUrl(trimmed)) {
      errors.push('Site URL must be http/https');
      return null;
    }
    const safety = await validateSsrfUrlAsync(trimmed);
    if (!safety.valid) {
      errors.push(`Site URL is not safe: ${safety.reason ?? 'potential SSRF'}`);
      return null;
    }

    try {
      return normalizeUrlForStorage(trimmed);
    } catch {
      errors.push('Invalid site URL (htmlUrl)');
      return null;
    }
  }

  private async normalizeAndValidateFeedUrl(raw: string, errors: string[]): Promise<string | null> {
    const trimmed = raw.trim();
    if (!trimmed) {
      errors.push('Missing feed URL (xmlUrl)');
      return null;
    }
    if (!isHttpUrl(trimmed)) {
      errors.push('Feed URL must be http/https');
      return null;
    }
    const safety = await validateSsrfUrlAsync(trimmed);
    if (!safety.valid) {
      errors.push(`Feed URL is not safe: ${safety.reason ?? 'potential SSRF'}`);
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      errors.push('Invalid feed URL (xmlUrl)');
      return null;
    }
  }

  private async findExistingSourceUrlSet(orgId: string, urls: string[]) {
    const candidates = new Set<string>();
    for (const url of urls) {
      for (const candidate of buildUrlEquivalenceCandidates(url)) {
        candidates.add(candidate);
      }
    }

    const list = Array.from(candidates);
    if (list.length === 0) {
      return new Set<string>();
    }

    const rows = await this.prisma.newsSource.findMany({
      where: {
        orgId,
        url: {
          in: list,
        },
      },
      select: {
        url: true,
      },
    });

    return new Set(rows.map((row) => row.url));
  }

  private buildDefaultRssSeedConfig(feedUrl: string) {
    return {
      seed: {
        enabled: true,
        mode: 'rss',
        feedUrl,
        maxUrls: 200,
        maxNewUrlsPerRun: 80,
        scoreThreshold: 0,
        concurrency: 5,
        dedupeWindowHours: 24,
      },
    };
  }

  private isUniqueUrlConflict(error: unknown) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }

    const metaTarget = (error.meta as { target?: unknown } | undefined)?.target;
    const targetParts = Array.isArray(metaTarget)
      ? metaTarget.map((entry) => String(entry))
      : typeof metaTarget === 'string'
        ? [metaTarget]
        : [];

    const normalized = targetParts.map((entry) => entry.toLowerCase());
    return (
      normalized.includes('url') ||
      (normalized.includes('orgid') && normalized.includes('url')) ||
      normalized.some((entry) => entry.includes('newssource_orgid_url_key'))
    );
  }
}
