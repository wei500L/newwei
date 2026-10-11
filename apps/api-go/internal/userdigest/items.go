package userdigest

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// matchedProcessedItemIDs 先用 Elasticsearch 的 itemMetaId 命中（失败或客户端
// 缺失则回退 Mongo 关键词），地理条件始终走 Mongo。返回的是 ProcessedItem._id
// 的十六进制字符串，供 NewsEventItem.processedItemId 过滤。
func (s *Service) matchedProcessedItemIDs(ctx context.Context, orgID string, since time.Time, subs personalnews.DigestSubscriptionValues, candidateLimit int) ([]string, error) {
	matched := make([]string, 0)
	seen := map[string]struct{}{}
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		matched = append(matched, id)
	}
	useKeywordMongo := len(subs.FocusKeywords) > 0
	if len(subs.FocusKeywords) > 0 && s.search != nil {
		hits, err := s.search.SearchLiteralKeywords(ctx, orgID, subs.FocusKeywords, since, candidateLimit)
		if err != nil {
			log.Printf("userdigest: digest elasticsearch keyword search failed; falling back to mongo orgId=%s: %v", orgID, err)
		} else {
			useKeywordMongo = false
			metaIDs := make([]string, 0, len(hits))
			for _, hit := range hits {
				metaIDs = append(metaIDs, hit.ID)
			}
			metaIDs = dedupeNonEmpty(metaIDs)
			if len(metaIDs) > candidateLimit {
				metaIDs = metaIDs[:candidateLimit]
			}
			resolved, err := s.resolveProcessedItemIDs(ctx, orgID, since, metaIDs, candidateLimit)
			if err != nil {
				return nil, err
			}
			for _, id := range resolved {
				add(id)
			}
		}
	}
	filters := processedItemFilters(subs, useKeywordMongo, true)
	if len(filters) == 0 {
		return matched, nil
	}
	ids, err := s.findProcessedItemIDs(ctx, orgID, since, filters, candidateLimit)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		add(id)
	}
	return matched, nil
}

// resolveProcessedItemIDs 把 ES 的 itemMetaId 解析成 ProcessedItem._id。
// 条件与 Nest 一致：同 org、status=completed、duplicateOf=null、createdAt>=since、
// itemMetaId $in。按 createdAt 倒序，每个 itemMetaId 只留第一条，再按输入
// itemMetaId 的顺序输出。
func (s *Service) resolveProcessedItemIDs(ctx context.Context, orgID string, since time.Time, itemMetaIDs []string, candidateLimit int) ([]string, error) {
	ids := dedupeNonEmpty(itemMetaIDs)
	if len(ids) > candidateLimit {
		ids = ids[:candidateLimit]
	}
	if len(ids) == 0 {
		return nil, nil
	}
	if s == nil || s.items == nil {
		return nil, fmt.Errorf("%w: mongo is not configured", errMongo)
	}
	resolveLimit := len(ids) * processedItemResolveFactor
	if resolveLimit < candidateLimit {
		resolveLimit = candidateLimit
	}
	if resolveLimit > processedItemResolveMax {
		resolveLimit = processedItemResolveMax
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "duplicateOf", Value: nil},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since.UTC()}}},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ids}}},
	}
	cursor, err := s.items.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(resolveLimit)).
		SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "itemMetaId", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("%w: resolve processed items: %v", errMongo, err)
	}
	defer cursor.Close(ctx)
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("%w: resolve processed items: %v", errMongo, err)
	}
	byMeta := map[string]string{}
	for _, doc := range docs {
		meta, _ := doc["itemMetaId"].(string)
		meta = strings.TrimSpace(meta)
		id := mongoHexID(doc["_id"])
		if meta == "" || id == "" {
			continue
		}
		if _, ok := byMeta[meta]; ok {
			continue
		}
		byMeta[meta] = id
	}
	out := make([]string, 0, len(ids))
	for _, meta := range ids {
		id := byMeta[meta]
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	return out, nil
}

func (s *Service) findProcessedItemIDs(ctx context.Context, orgID string, since time.Time, filters bson.A, candidateLimit int) ([]string, error) {
	if len(filters) == 0 {
		return nil, nil
	}
	if s == nil || s.items == nil {
		return nil, fmt.Errorf("%w: mongo is not configured", errMongo)
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "duplicateOf", Value: nil},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since.UTC()}}},
		{Key: "$or", Value: filters},
	}
	cursor, err := s.items.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(candidateLimit)).
		SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("%w: processed item filters: %v", errMongo, err)
	}
	defer cursor.Close(ctx)
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("%w: processed item filters: %v", errMongo, err)
	}
	out := make([]string, 0, len(docs))
	seen := map[string]struct{}{}
	for _, doc := range docs {
		id := mongoHexID(doc["_id"])
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

func processedItemFilters(subs personalnews.DigestSubscriptionValues, includeKeywords, includeGeos bool) bson.A {
	filters := make(bson.A, 0)
	if includeKeywords {
		for _, keyword := range subs.FocusKeywords {
			if filter := keywordFilter(keyword); filter != nil {
				filters = append(filters, filter)
			}
		}
	}
	if includeGeos {
		for _, geo := range subs.FocusGeos {
			if filter := geoFilter(geo.DisplayValue, geo.NormalizedValue, geo.CountryCodeAlpha2); filter != nil {
				filters = append(filters, filter)
			}
		}
	}
	return filters
}

func dedupeNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func mongoHexID(value any) string {
	switch typed := value.(type) {
	case bson.ObjectID:
		return typed.Hex()
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}
