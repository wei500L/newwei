import type { ColumnID, HiddenColumnID, Metadata, Source, SourceID } from "../news-aggregator.types"

function typeSafeObjectFromEntries<
  const T extends readonly (readonly [PropertyKey, unknown])[],
>(entries: T): { [K in T[number]as K[0]]: K[1] } {
  return Object.fromEntries(entries) as { [K in T[number]as K[0]]: K[1] }
}

function typeSafeObjectEntries<T extends Record<PropertyKey, unknown>>(obj: T): { [K in keyof T]: [K, T[K]] }[keyof T][] {
  return Object.entries(obj) as { [K in keyof T]: [K, T[K]] }[keyof T][]
}

export const columns = {
  china: {
    zh: "国内",
  },
  world: {
    zh: "国际",
  },
  tech: {
    zh: "科技",
  },
  finance: {
    zh: "财经",
  },
  focus: {
    zh: "关注",
  },
  realtime: {
    zh: "实时",
  },
  hottest: {
    zh: "最热",
  },
} as const

export const fixedColumnIds = ["focus", "hottest", "realtime"] as const satisfies Partial<ColumnID>[]

// Fixed column ids are the only columns the console always renders, so they are
// exactly the ones hiddenColumns must exclude. Both sets are strings, which lets
// the filter narrow `string` to HiddenColumnID without an `any` cast.
const fixedColumnIdSet: ReadonlySet<string> = new Set<string>(fixedColumnIds)
const isHiddenColumnID = (id: string): id is HiddenColumnID => !fixedColumnIdSet.has(id)

export const hiddenColumns = Object.keys(columns).filter(isHiddenColumnID)

export function genMetadata(sources: Record<SourceID, Source>): Metadata {
  return typeSafeObjectFromEntries(typeSafeObjectEntries(columns).map(([k, v]) => {
  switch (k) {
    case "focus":
      return [k, {
        name: v.zh,
        sources: [] as SourceID[],
      }]
    case "hottest":
      return [k, {
        name: v.zh,
        sources: typeSafeObjectEntries(sources).filter(([, v]) => v.type === "hottest" && !v.redirect).map(([k]) => k),
      }]
    case "realtime":
      return [k, {
        name: v.zh,
        sources: typeSafeObjectEntries(sources).filter(([, v]) => v.type === "realtime" && !v.redirect).map(([k]) => k),
      }]
    default:
      return [k, {
        name: v.zh,
        sources: typeSafeObjectEntries(sources).filter(([, v]) => v.column === k && !v.redirect).map(([k]) => k),
      }]
  }
}))
}
