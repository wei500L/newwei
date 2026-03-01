import * as cheerio from "cheerio"

import type { NewsItem, RSSHubInfo as RSSHubResponse } from "../news-aggregator.types"

import { myFetch } from "./fetch"
import { rss2json } from "./rss2json"
import { defineSource } from "./source"

const sourceName = "freebuf"
const rssHubInstances = [
  "https://rsshub.rssforever.com",
  "https://rsshub.app",
]
const rssHubTypes = ["web", "system"] as const
const nativeFeedUrl = "https://www.freebuf.com/feed"

function toTimestamp(value: NewsItem["pubDate"]): number {
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value)
    return Number.isNaN(timestamp) ? 0 : timestamp
  }
  return 0
}

function normalizeUrl(url: string): string {
  return url.trim()
}

function getDedupeKey(item: NewsItem): string {
  const url = normalizeUrl(item.url)
  if (url.length > 0) {
    return url
  }
  return `${item.id}`
}

function stripHtml(content: string | undefined): string {
  if (!content) {
    return ""
  }
  const $ = cheerio.load(`<div>${content}</div>`)
  return $("div").text().trim()
}

function mergeAndSort(items: NewsItem[]): NewsItem[] {
  const deduped = new Map<string, NewsItem>()

  for (const item of items) {
    const key = getDedupeKey(item)
    if (!deduped.has(key)) {
      deduped.set(key, item)
    }
  }

  return [...deduped.values()].sort(
    (left, right) => toTimestamp(right.pubDate) - toTimestamp(left.pubDate),
  )
}

function toRssHubItem(item: RSSHubResponse["items"][number]): NewsItem {
  return {
    id: item.id ?? item.url,
    title: item.title,
    url: item.url,
    pubDate: item.date_published,
  }
}

async function fetchFromRssHubInstance(instance: string): Promise<NewsItem[]> {
  const settled = await Promise.allSettled(
    rssHubTypes.map(async (type) => {
      const routeUrl = new URL(`/freebuf/articles/${type}`, instance)
      routeUrl.searchParams.set("format", "json")
      routeUrl.searchParams.set("limit", "40")
      routeUrl.searchParams.set("sorted", "true")
      const payload: RSSHubResponse = await myFetch(routeUrl.toString())
      return payload.items.map(toRssHubItem)
    }),
  )

  const collected: NewsItem[] = []
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      collected.push(...result.value)
      return
    }
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
    const type = rssHubTypes[index] ?? "unknown"
    console.warn(`[${sourceName}] rsshub ${instance} type=${type} failed: ${reason}`)
  })

  return collected
}

function isTargetCategoryUrl(url: string): boolean {
  return url.includes("/articles/web/") || url.includes("/articles/system/")
}

async function fetchFromNativeFeed(): Promise<NewsItem[]> {
  try {
    const data = await rss2json(nativeFeedUrl)
    if (!data?.items?.length) {
      return []
    }

    const mapped = data.items.map((item) => ({
      id: item.link,
      title: item.title,
      url: item.link,
      pubDate: item.created,
      extra: {
        hover: stripHtml(item.description),
      },
    }))

    const categoryMatched = mapped.filter(item => isTargetCategoryUrl(item.url))
    if (categoryMatched.length > 0) {
      return categoryMatched
    }
    return mapped
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[${sourceName}] native feed failed: ${reason}`)
    return []
  }
}

export default defineSource(async () => {
  for (const instance of rssHubInstances) {
    const items = await fetchFromRssHubInstance(instance)
    if (items.length > 0) {
      return mergeAndSort(items)
    }
  }

  const fallbackItems = await fetchFromNativeFeed()
  if (fallbackItems.length > 0) {
    return mergeAndSort(fallbackItems)
  }

  return []
})
