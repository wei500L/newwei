// Package itemsreading implements the item reading and RSS search-assist
// endpoints that the Go gateway takes over from NestJS behind
// API_GO_ITEMS_READING_MODE=go.
//
// The package talks to the real MySQL, Mongo and Redis instances directly: it
// never proxies NestJS for a route it claims to serve. Two REST routes
// (GET /api/items and GET /api/items/:id) plus six GraphQL roots
// (item, itemFacets, rssSources, rssTranslationStatus, searchSuggestions and
// the items connection) are built on the same strongly typed read core.
//
// The items connection root (API_GO_GRAPHQL_ITEMS_LIST_MODE=go) additionally
// implements filtering, page and composite (time, id) cursor pagination, the
// CREATED_DESC / PUBLISHED_DESC orderings, the RELEVANCE rerank pipeline and the
// PERSONALIZED behavior-profile ordering. Those live in itemslist.go, listtime.go,
// relevance.go, personalized.go and rerank.go; ListItems is the entry point.
//
// Tenant binding rules that the whole package must preserve:
//   - Every MySQL query carries the caller's orgId, derived from the
//     authenticated identity (never from a request parameter or header).
//   - Every Mongo query on a collection that has an orgId field carries that
//     orgId. RawItem has no orgId column, so a raw document is only trusted
//     when its _id equals the organization-scoped ItemMeta.mongoRef AND its
//     own itemMetaId points back at that meta.
//   - Search candidates, filters, facets, RSS window statistics and
//     suggestions are all scoped to one organization.
package itemsreading
