import type { columns, fixedColumnIds } from "./data/metadata"
import type { originSources } from "./data/pre-sources"

export type Color = string

type ConstSources = typeof originSources
type MainSourceID = keyof ConstSources

export type SourceID = {
  [Key in MainSourceID]: ConstSources[Key] extends { disable?: true } ? never :
    ConstSources[Key] extends { sub?: infer SubSource } ? {
      [SubKey in keyof SubSource]: SubSource[SubKey] extends { disable?: true } ? never : `${Key & string}-${SubKey & string}`
    }[keyof SubSource] | (Key & string) : (Key & string)
}[MainSourceID]

export type AllSourceID = {
  [Key in MainSourceID]: ConstSources[Key] extends { sub?: infer SubSource } ? keyof {
    [SubKey in keyof SubSource as `${Key & string}-${SubKey & string}`]: never
  } | (Key & string) : (Key & string)
}[MainSourceID]

export type ColumnID = keyof typeof columns
export type Metadata = Record<ColumnID, Column>

export interface PrimitiveMetadata {
  updatedTime: number
  data: Record<FixedColumnID, SourceID[]>
  action: "init" | "manual" | "sync"
}

export type FixedColumnID = (typeof fixedColumnIds)[number]
export type HiddenColumnID = Exclude<ColumnID, FixedColumnID>

export interface OriginSource extends Partial<Omit<Source, "name" | "redirect">> {
  name: string
  sub?: Record<string, {
    title: string
  } & Partial<Omit<Source, "title" | "name" | "redirect">>>
}

export interface Source {
  name: string
  interval: number
  color: Color
  title?: string
  desc?: string
  type?: "hottest" | "realtime"
  column?: HiddenColumnID
  home?: string
  disable?: boolean | "cf"
  redirect?: SourceID
}

export interface Column {
  name: string
  sources: SourceID[]
}

export interface NewsItem {
  id: string | number
  title: string
  url: string
  mobileUrl?: string
  pubDate?: number | string
  extra?: {
    hover?: string
    date?: number | string
    info?: false | string
    diff?: number
    icon?: false | string | {
      url: string
      scale: number
    }
    [key: string]: unknown
  }
}

export interface SourceResponse {
  status: "success" | "cache"
  id: SourceID
  updatedTime: number | string
  items: NewsItem[]
}

export interface NewsResolveResponse {
  matched: boolean
  itemId?: string
  eventId?: string
  confidence?: number
  matchedUrl?: string
}

export interface SourceRuntimeContext {
  sourceId: SourceID
  requestedSourceId: SourceID
  secrets: Record<string, string>
}

export type SourceGetter = (context?: SourceRuntimeContext) => Promise<NewsItem[]>

export interface CacheInfo {
  id: SourceID
  items: NewsItem[]
  updated: number
}

export interface RSSInfo {
  title: string
  description: string
  link: string
  image: string
  updatedTime: string
  items: RSSItem[]
}

export interface RSSItem {
  title: string
  description: string
  link: string
  created?: string
}

export interface RSSHubInfo {
  title: string
  home_page_url: string
  description: string
  items: RSSHubItem[]
}

export interface RSSHubItem {
  id: string
  url: string
  title: string
  content_html: string
  date_published: string
}

export interface RSSHubOption {
  sorted?: boolean
  limit?: number
}

export interface SourceOption {
  hiddenDate?: boolean
}
