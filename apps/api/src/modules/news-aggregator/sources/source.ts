import type {
  AllSourceID,
  NewsItem,
  RSSHubInfo as RSSHubResponse,
  RSSHubOption,
  SourceRuntimeContext,
  SourceGetter,
  SourceOption,
} from "../news-aggregator.types"

import { myFetch } from "./fetch"
import { rss2json } from "./rss2json"

type AnySourceGetter = (context?: SourceRuntimeContext) => Promise<any[]>
type SourceMap = Partial<Record<AllSourceID | string, AnySourceGetter>>

export function defineSource<T extends AnySourceGetter>(source: T): T
export function defineSource<T extends SourceMap>(source: T): T
export function defineSource<T extends AnySourceGetter | SourceMap>(source: T): T {
  return source
}

export function defineRSSSource(url: string, option?: SourceOption): SourceGetter {
  return async () => {
    const data = await rss2json(url)
    if (!data?.items.length) throw new Error("Cannot fetch rss data")
    return data.items.map((item) => ({
      title: item.title,
      url: item.link,
      id: item.link,
      pubDate: !option?.hiddenDate ? item.created : undefined,
    }))
  }
}

export function defineRSSHubSource(route: string, rssHubOptions?: RSSHubOption, sourceOption?: SourceOption): SourceGetter {
  return async () => {
    const RSSHubBase = "https://rsshub.rssforever.com"
    const url = new URL(route, RSSHubBase)
    url.searchParams.set("format", "json")

    const mergedOptions: RSSHubOption = {
      sorted: true,
      ...rssHubOptions,
    }

    Object.entries(mergedOptions).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    })

    const data: RSSHubResponse = await myFetch(url.toString())
    const items = mergedOptions.limit ? data.items.slice(0, mergedOptions.limit) : data.items

    return items.map((item) => ({
      title: item.title,
      url: item.url,
      id: item.id ?? item.url,
      pubDate: !sourceOption?.hiddenDate ? item.date_published : undefined,
    }))
  }
}
