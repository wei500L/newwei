package userdigest

import (
	"context"
	"errors"
	"time"
)

// processedItemsCollection 是 Mongoose 默认集合名：ProcessedItem → processeditems。
const processedItemsCollection = "processeditems"

// ErrSearchDisabled 表示 Elasticsearch 客户端没配（Nest searchLiteralKeywords
// 在 !client 时返回 null）。调用方应回退 Mongo，不要因此让进程起不来。
var ErrSearchDisabled = errors.New("elasticsearch client is disabled")

// KeywordHit 是一次字面关键词命中。ID 是文档 _source.itemMetaId，
// 不是 ProcessedItem 的 _id。摘要再拿这个 id 去 Mongo 的 itemMetaId 字段
// 找 completed、非重复的 ProcessedItem，用它的 _id 对齐
// NewsEventItem.processedItemId。
type KeywordHit struct {
	ID string
}

// ItemSearcher 是本包实际用到的 Elasticsearch 调用。
// nil 等同 Nest @Optional() 没注入 ItemsElasticsearchService：关键词走 Mongo。
// 非 nil 但客户端不可用时返回 ErrSearchDisabled 或任意 error，同样回退 Mongo，
// 不把这次摘要请求打成 500。返回空切片且 error 为 nil 表示搜索成功但没有命中，
// 此时不再用 Mongo 做关键词匹配（地理条件仍走 Mongo）。
type ItemSearcher interface {
	SearchLiteralKeywords(ctx context.Context, orgID string, keywords []string, createdAtGte time.Time, limit int) ([]KeywordHit, error)
}
