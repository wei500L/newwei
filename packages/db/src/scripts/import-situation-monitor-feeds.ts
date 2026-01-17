import { baseEnvSchema, loadAndValidateEnv } from "@modular/utils";
import { NewsSourceType, PrismaClient } from "@prisma/client";
import path from "node:path";
import process from "node:process";

type SituationMonitorCategory = "politics" | "tech" | "finance" | "gov" | "ai" | "intel";

interface SituationMonitorFeed {
  name: string;
  url: string;
  category: SituationMonitorCategory;
}

const CATEGORY_TO_SITE_TYPE: Record<SituationMonitorCategory, NewsSourceType> = {
  politics: NewsSourceType.politics,
  tech: NewsSourceType.technology,
  finance: NewsSourceType.finance,
  gov: NewsSourceType.regulatory,
  ai: NewsSourceType.technology,
  intel: NewsSourceType.other,
};

const FEEDS: SituationMonitorFeed[] = [
  { category: "politics", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { category: "politics", name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml" },
  { category: "politics", name: "Guardian World", url: "https://www.theguardian.com/world/rss" },
  { category: "politics", name: "NYT World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { category: "tech", name: "Hacker News", url: "https://hnrss.org/frontpage" },
  { category: "tech", name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
  { category: "tech", name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { category: "tech", name: "MIT Tech Review", url: "https://www.technologyreview.com/feed/" },
  { category: "tech", name: "ArXiv AI", url: "https://rss.arxiv.org/rss/cs.AI" },
  { category: "tech", name: "OpenAI Blog", url: "https://openai.com/news/rss.xml" },
  { category: "finance", name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  {
    category: "finance",
    name: "MarketWatch",
    url: "https://feeds.marketwatch.com/marketwatch/topstories",
  },
  { category: "finance", name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { category: "finance", name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { category: "finance", name: "FT", url: "https://www.ft.com/rss/home" },
  { category: "gov", name: "White House", url: "https://www.whitehouse.gov/news/feed/" },
  { category: "gov", name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { category: "gov", name: "SEC Announcements", url: "https://www.sec.gov/news/pressreleases.rss" },
  {
    category: "gov",
    name: "DoD News",
    url: "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?max=10&ContentType=1&Site=945",
  },
  { category: "intel", name: "CSIS", url: "https://www.csis.org/analysis/feed" },
  { category: "intel", name: "Brookings", url: "https://www.brookings.edu/feed/" },
  { category: "intel", name: "CFR", url: "https://www.cfr.org/rss.xml" },
  { category: "intel", name: "Defense One", url: "https://www.defenseone.com/rss/all/" },
  { category: "intel", name: "War on Rocks", url: "https://warontherocks.com/feed/" },
  { category: "intel", name: "Breaking Defense", url: "https://breakingdefense.com/feed/" },
  { category: "intel", name: "The Drive War Zone", url: "https://www.thedrive.com/the-war-zone/feed" },
  { category: "intel", name: "The Diplomat", url: "https://thediplomat.com/feed/" },
  { category: "intel", name: "Al-Monitor", url: "https://www.al-monitor.com/rss" },
  { category: "intel", name: "Bellingcat", url: "https://www.bellingcat.com/feed/" },
  { category: "intel", name: "CISA Alerts", url: "https://www.cisa.gov/uscert/ncas/alerts.xml" },
  { category: "intel", name: "Krebs Security", url: "https://krebsonsecurity.com/feed/" },
];

function getArgValue(name: string): string | undefined {
  const prefix = `--${name}`;
  const index = process.argv.findIndex((arg) => arg === prefix || arg.startsWith(`${prefix}=`));
  if (index === -1) {
    return undefined;
  }
  const raw = process.argv[index];
  if (!raw) {
    return undefined;
  }
  if (raw.includes("=")) {
    return raw.split("=").slice(1).join("=").trim() || undefined;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    return undefined;
  }
  return next.trim() || undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const orgSlug = getArgValue("orgSlug") ?? "acme";
  const dryRun = hasFlag("dryRun");
  const isActive = !hasFlag("inactive");

  const env = loadAndValidateEnv(baseEnvSchema, {
    dotenvPath: path.resolve(process.cwd(), "../../.env"),
    overrideProcessEnv: true,
  });

  const connectionString =
    process.env.DATABASE_URL ??
    `mysql://${env.MYSQL_USER}:${encodeURIComponent(env.MYSQL_PASSWORD)}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DB}`;

  process.env.DATABASE_URL = connectionString;

  const prisma = new PrismaClient();
  try {
    const org = await prisma.org.upsert({
      where: { slug: orgSlug },
      update: {},
      create: {
        name: orgSlug,
        slug: orgSlug,
        description: "Imported org (situation-monitor)",
        isActive: true,
      },
      select: { id: true, slug: true },
    });

    const feeds = Array.from(new Map(FEEDS.map((feed) => [feed.url, feed])).values());

    const existing = await prisma.newsSource.findMany({
      where: { orgId: org.id, url: { in: feeds.map((feed) => feed.url) } },
      select: { url: true },
    });
    const existingUrls = new Set(existing.map((row) => row.url));

    const pendingCreates = feeds.filter((feed) => !existingUrls.has(feed.url));

    console.log(
      `Org=${org.slug} total=${feeds.length} existing=${existingUrls.size} create=${pendingCreates.length} dryRun=${dryRun}`,
    );

    if (dryRun || pendingCreates.length === 0) {
      return;
    }

    await prisma.newsSource.createMany({
      data: pendingCreates.map((feed) => ({
        orgId: org.id,
        name: feed.name,
        url: feed.url,
        siteType: CATEGORY_TO_SITE_TYPE[feed.category],
        language: "en",
        frequencySeconds: 3600,
        priority: 0,
        isActive,
        config: {
          tags: ["rss", "situation-monitor", `sm:${feed.category}`],
          seed: {
            enabled: true,
            mode: "rss",
            feedUrl: feed.url,
            maxUrls: 50,
            maxNewUrlsPerRun: 10,
            scoreThreshold: 0,
            dedupeWindowHours: 24,
            cacheTtlSeconds: 600,
            concurrency: 5,
          },
        },
      })),
      skipDuplicates: true,
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Failed to import situation-monitor feeds", error);
  process.exit(1);
});

