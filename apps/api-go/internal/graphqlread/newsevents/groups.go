package newsevents

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	processedItemsCollection = "processeditems"
	topicCacheTTL            = 120 * time.Second
	eventCacheTTL            = 120 * time.Second
)

func (s *service) topicGroups(ctx contract.Context) (any, error) {
	limit := optionalInt(ctx.Args, "limit", 12, 1, 50)
	itemsPerGroup := optionalInt(ctx.Args, "itemsPerGroup", 5, 1, 8)
	windowDays := optionalInt(ctx.Args, "windowDays", 30, 1, 180)
	return s.cachedGroups(s.call(ctx), topicCacheKey(ctx.Identity.OrgID, limit, itemsPerGroup, windowDays), topicCacheTTL, func() ([]TopicGroupModel, error) {
		return s.queryTopicGroups(s.call(ctx), ctx.Identity.OrgID, limit, itemsPerGroup, windowDays)
	})
}

func (s *service) eventGroups(ctx contract.Context) (any, error) {
	limit := optionalInt(ctx.Args, "limit", 12, 1, 50)
	itemsPerGroup := optionalInt(ctx.Args, "itemsPerGroup", 5, 1, 8)
	windowDays := optionalInt(ctx.Args, "windowDays", 30, 1, 180)
	minGroupSize := optionalInt(ctx.Args, "minGroupSize", 2, 1, 50)
	return s.cachedEventGroups(s.call(ctx), eventCacheKey(ctx.Identity.OrgID, limit, itemsPerGroup, windowDays, minGroupSize), func() ([]EventGroupModel, error) {
		return s.queryEventGroups(s.call(ctx), ctx.Identity.OrgID, limit, itemsPerGroup, windowDays, minGroupSize)
	})
}

func topicCacheKey(orgID string, limit, items, window int) string {
	return "items:topic-groups:" + orgID + ":" + itoa(limit) + ":" + itoa(items) + ":" + itoa(window)
}

func eventCacheKey(orgID string, limit, items, window, minSize int) string {
	return "items:event-groups:" + orgID + ":" + itoa(limit) + ":" + itoa(items) + ":" + itoa(window) + ":" + itoa(minSize)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := [20]byte{}
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}

func (s *service) cachedGroups(ctx context.Context, key string, ttl time.Duration, load func() ([]TopicGroupModel, error)) (any, error) {
	if s == nil || s.mongo == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	if cached, ok, err := redisGet(ctx, s.redis, key); err != nil {
		return nil, err
	} else if ok {
		if string(cached) == "[]" {
			return []TopicGroupModel{}, nil
		}
		var payload []cachedTopicGroup
		if json.Unmarshal(cached, &payload) == nil && len(payload) > 0 {
			parsed := make([]TopicGroupModel, 0, len(payload))
			valid := true
			for _, group := range payload {
				latest, err := time.Parse(time.RFC3339Nano, group.LatestAt)
				if err != nil {
					valid = false
					break
				}
				parsed = append(parsed, group.model(latest))
			}
			if valid && len(parsed) > 0 {
				return parsed, nil
			}
		}
	}
	groups, err := load()
	if err != nil {
		return nil, err
	}
	if err := redisSet(ctx, s.redis, key, topicCachePayload(groups), ttl); err != nil {
		return nil, err
	}
	return groups, nil
}

func (s *service) cachedEventGroups(ctx context.Context, key string, load func() ([]EventGroupModel, error)) (any, error) {
	if s == nil || s.mongo == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	if cached, ok, err := redisGet(ctx, s.redis, key); err != nil {
		return nil, err
	} else if ok {
		if string(cached) == "[]" {
			return []EventGroupModel{}, nil
		}
		var payload []cachedEventGroup
		if json.Unmarshal(cached, &payload) == nil && len(payload) > 0 {
			parsed := make([]EventGroupModel, 0, len(payload))
			valid := true
			for _, group := range payload {
				latest, err := time.Parse(time.RFC3339Nano, group.LatestAt)
				if err != nil {
					valid = false
					break
				}
				parsed = append(parsed, group.model(latest))
			}
			if valid && len(parsed) > 0 {
				return parsed, nil
			}
		}
	}
	groups, err := load()
	if err != nil {
		return nil, err
	}
	if err := redisSet(ctx, s.redis, key, eventCachePayload(groups), eventCacheTTL); err != nil {
		return nil, err
	}
	return groups, nil
}

func redisGet(ctx context.Context, client *redis.Client, key string) ([]byte, bool, error) {
	if client == nil {
		return nil, false, nil
	}
	raw, err := client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 {
		return nil, false, nil
	}
	return raw, true, nil
}

func redisSet(ctx context.Context, client *redis.Client, key string, value any, ttl time.Duration) error {
	if client == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return client.Set(ctx, key, raw, ttl).Err()
}

func (s *service) queryTopicGroups(ctx context.Context, orgID string, limit, itemsPerGroup, windowDays int) ([]TopicGroupModel, error) {
	since := s.clock().Add(-time.Duration(windowDays) * day)
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, topicPipeline(orgID, since, itemsPerGroup, limit))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]TopicGroupModel, 0)
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		latest, ok := asTime(doc["latestAt"])
		if !ok {
			continue
		}
		out = append(out, TopicGroupModel{
			Topic:    stringifyID(doc["_id"]),
			Count:    asInt(doc["count"]),
			LatestAt: latest,
			Items:    mapTopicItems(doc["items"]),
		})
	}
	return out, cursor.Err()
}

func (s *service) queryEventGroups(ctx context.Context, orgID string, limit, itemsPerGroup, windowDays, minGroupSize int) ([]EventGroupModel, error) {
	since := s.clock().Add(-time.Duration(windowDays) * day)
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, eventPipeline(orgID, since, itemsPerGroup, limit, minGroupSize))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]EventGroupModel, 0)
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		latest, ok := asTime(doc["latestAt"])
		if !ok {
			continue
		}
		out = append(out, EventGroupModel{
			EventID:     stringifyID(doc["_id"]),
			Count:       asInt(doc["count"]),
			LatestAt:    latest,
			Title:       stringPtr(doc["title"]),
			Summary:     stringPtr(doc["summary"]),
			Source:      stringPtr(doc["source"]),
			PublishedAt: stringPtr(doc["publishedAt"]),
			Topics:      stringList(doc["topics"]),
			Entities:    entityNames(doc["entities"]),
			Items:       mapEventItems(doc["items"]),
		})
	}
	return out, cursor.Err()
}

func topicPipeline(orgID string, since time.Time, itemLimit, groupLimit int) bson.A {
	return bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			{Key: "result.topics.0", Value: bson.D{{Key: "$exists", Value: true}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "ingestedAt", Value: 1},
			{Key: "sortAt", Value: 1},
			{Key: "result", Value: 1},
		}}},
		bson.D{{Key: "$addFields", Value: bson.D{
			{Key: "ingestedAt", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}},
			{Key: "sortAt", Value: sortAtExpr()},
		}}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "sortAt", Value: bson.D{{Key: "$gte", Value: since}}}}}},
		bson.D{{Key: "$unwind", Value: "$result.topics"}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "result.topics", Value: bson.D{{Key: "$nin", Value: bson.A{nil, ""}}}}}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "sortAt", Value: -1}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$result.topics"},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "latestAt", Value: bson.D{{Key: "$first", Value: "$sortAt"}}},
			{Key: "items", Value: bson.D{{Key: "$push", Value: itemPush()}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 1},
			{Key: "count", Value: 1},
			{Key: "latestAt", Value: 1},
			{Key: "items", Value: bson.D{{Key: "$slice", Value: bson.A{"$items", itemLimit}}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "latestAt", Value: -1}, {Key: "count", Value: -1}}}},
		bson.D{{Key: "$limit", Value: groupLimit}},
	}
}

func eventPipeline(orgID string, since time.Time, itemLimit, groupLimit, minGroupSize int) bson.A {
	return bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "ingestedAt", Value: 1},
			{Key: "sortAt", Value: 1},
			{Key: "duplicateOf", Value: 1},
			{Key: "result", Value: 1},
		}}},
		bson.D{{Key: "$addFields", Value: bson.D{
			{Key: "primaryTopic", Value: bson.D{{Key: "$arrayElemAt", Value: bson.A{
				bson.D{{Key: "$ifNull", Value: bson.A{"$result.topics", bson.A{}}}},
				0,
			}}}},
			{Key: "primaryEntity", Value: primaryEntityExpr()},
			{Key: "ingestedAt", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}},
			{Key: "sortAt", Value: sortAtExpr()},
		}}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "sortAt", Value: bson.D{{Key: "$gte", Value: since}}}}}},
		bson.D{{Key: "$addFields", Value: bson.D{
			{Key: "entityKey", Value: prefixedKey("entity:", "$primaryEntity")},
			{Key: "topicKey", Value: prefixedKey("topic:", "$primaryTopic")},
		}}},
		bson.D{{Key: "$addFields", Value: bson.D{
			{Key: "groupId", Value: bson.D{{Key: "$ifNull", Value: bson.A{
				"$duplicateOf",
				bson.D{{Key: "$ifNull", Value: bson.A{"$entityKey", bson.D{{Key: "$ifNull", Value: bson.A{"$topicKey", "$_id"}}}}}},
			}}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "sortAt", Value: -1}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$groupId"},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "latestAt", Value: bson.D{{Key: "$first", Value: "$sortAt"}}},
			{Key: "title", Value: bson.D{{Key: "$first", Value: "$result.title"}}},
			{Key: "summary", Value: bson.D{{Key: "$first", Value: "$result.summary"}}},
			{Key: "source", Value: bson.D{{Key: "$first", Value: "$result.source"}}},
			{Key: "publishedAt", Value: bson.D{{Key: "$first", Value: "$result.published_at"}}},
			{Key: "topics", Value: bson.D{{Key: "$first", Value: "$result.topics"}}},
			{Key: "entities", Value: bson.D{{Key: "$first", Value: "$result.entities"}}},
			{Key: "items", Value: bson.D{{Key: "$push", Value: itemPush()}}},
		}}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "count", Value: bson.D{{Key: "$gte", Value: minGroupSize}}}}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 1},
			{Key: "count", Value: 1},
			{Key: "latestAt", Value: 1},
			{Key: "title", Value: 1},
			{Key: "summary", Value: 1},
			{Key: "source", Value: 1},
			{Key: "publishedAt", Value: 1},
			{Key: "topics", Value: 1},
			{Key: "entities", Value: 1},
			{Key: "items", Value: bson.D{{Key: "$slice", Value: bson.A{"$items", itemLimit}}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "latestAt", Value: -1}, {Key: "count", Value: -1}}}},
		bson.D{{Key: "$limit", Value: groupLimit}},
	}
}

func sortAtExpr() bson.D {
	return bson.D{{Key: "$ifNull", Value: bson.A{
		"$sortAt",
		bson.D{{Key: "$convert", Value: bson.D{
			{Key: "input", Value: "$result.published_at"},
			{Key: "to", Value: "date"},
			{Key: "onError", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}},
			{Key: "onNull", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}},
		}}},
	}}}
}

func primaryEntityExpr() bson.D {
	return bson.D{{Key: "$arrayElemAt", Value: bson.A{
		bson.D{{Key: "$map", Value: bson.D{
			{Key: "input", Value: bson.D{{Key: "$filter", Value: bson.D{
				{Key: "input", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$result.entities", bson.A{}}}}},
				{Key: "as", Value: "entity"},
				{Key: "cond", Value: bson.D{{Key: "$and", Value: bson.A{
					bson.D{{Key: "$ne", Value: bson.A{"$$entity.name", nil}}},
					bson.D{{Key: "$ne", Value: bson.A{"$$entity.name", ""}}},
				}}}},
			}}}},
			{Key: "as", Value: "entity"},
			{Key: "in", Value: "$$entity.name"},
		}}},
		0,
	}}}
}

func prefixedKey(prefix, field string) bson.D {
	return bson.D{{Key: "$cond", Value: bson.A{
		bson.D{{Key: "$and", Value: bson.A{
			bson.D{{Key: "$ne", Value: bson.A{field, nil}}},
			bson.D{{Key: "$ne", Value: bson.A{field, ""}}},
		}}},
		bson.D{{Key: "$concat", Value: bson.A{prefix, field}}},
		nil,
	}}}
}

func itemPush() bson.D {
	return bson.D{
		{Key: "processedId", Value: "$_id"},
		{Key: "itemMetaId", Value: "$itemMetaId"},
		{Key: "title", Value: "$result.title"},
		{Key: "summary", Value: "$result.summary"},
		{Key: "source", Value: "$result.source"},
		{Key: "publishedAt", Value: "$result.published_at"},
		{Key: "createdAt", Value: "$ingestedAt"},
	}
}

func mapTopicItems(value any) []TopicItemModel {
	docs := asDocs(value)
	out := make([]TopicItemModel, 0, len(docs))
	for _, doc := range docs {
		created, _ := asTime(doc["createdAt"])
		out = append(out, TopicItemModel{
			ID:          stringifyID(doc["processedId"]),
			ItemMetaID:  plainString(doc["itemMetaId"]),
			Title:       stringPtr(doc["title"]),
			Summary:     stringPtr(doc["summary"]),
			Source:      stringPtr(doc["source"]),
			PublishedAt: stringPtr(doc["publishedAt"]),
			CreatedAt:   created,
		})
	}
	return out
}

func mapEventItems(value any) []EventGroupItemModel {
	docs := asDocs(value)
	out := make([]EventGroupItemModel, 0, len(docs))
	for _, doc := range docs {
		created, _ := asTime(doc["createdAt"])
		out = append(out, EventGroupItemModel{
			ID:          stringifyID(doc["processedId"]),
			ItemMetaID:  plainString(doc["itemMetaId"]),
			Title:       stringPtr(doc["title"]),
			Summary:     stringPtr(doc["summary"]),
			Source:      stringPtr(doc["source"]),
			PublishedAt: stringPtr(doc["publishedAt"]),
			CreatedAt:   created,
		})
	}
	return out
}

func asDocs(value any) []bson.M {
	list, ok := asSlice(value)
	if !ok {
		return nil
	}
	out := make([]bson.M, 0, len(list))
	for _, item := range list {
		if doc, ok := asMap(item); ok {
			out = append(out, doc)
		}
	}
	return out
}

func asSlice(value any) ([]any, bool) {
	switch typed := value.(type) {
	case bson.A:
		return []any(typed), true
	case []any:
		return typed, true
	default:
		return nil, false
	}
}

func asMap(value any) (bson.M, bool) {
	switch typed := value.(type) {
	case bson.M:
		return typed, true
	case bson.D:
		out := bson.M{}
		for _, elem := range typed {
			out[elem.Key] = elem.Value
		}
		return out, true
	default:
		return nil, false
	}
}

func asTime(value any) (time.Time, bool) {
	switch typed := value.(type) {
	case time.Time:
		return typed, !typed.IsZero()
	case bson.DateTime:
		return typed.Time(), true
	default:
		return time.Time{}, false
	}
}

func asInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func stringPtr(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

func plainString(value any) string {
	text, _ := value.(string)
	return text
}

func stringList(value any) []string {
	list, ok := asSlice(value)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		if ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}

func entityNames(value any) []string {
	list, ok := asSlice(value)
	if !ok {
		return []string{}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(list))
	for _, item := range list {
		doc, ok := asMap(item)
		if !ok {
			continue
		}
		name, _ := doc["name"].(string)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

type cachedTopicGroup struct {
	Topic    string       `json:"topic"`
	Count    int          `json:"count"`
	LatestAt string       `json:"latestAt"`
	Items    []cachedItem `json:"items"`
}

type cachedEventGroup struct {
	EventID     string       `json:"eventId"`
	Count       int          `json:"count"`
	LatestAt    string       `json:"latestAt"`
	Title       *string      `json:"title,omitempty"`
	Summary     *string      `json:"summary,omitempty"`
	Source      *string      `json:"source,omitempty"`
	PublishedAt *string      `json:"publishedAt,omitempty"`
	Topics      []string     `json:"topics"`
	Entities    []string     `json:"entities"`
	Items       []cachedItem `json:"items"`
}

type cachedItem struct {
	ProcessedID string  `json:"processedId"`
	ItemMetaID  string  `json:"itemMetaId"`
	Title       *string `json:"title,omitempty"`
	Summary     *string `json:"summary,omitempty"`
	Source      *string `json:"source,omitempty"`
	PublishedAt *string `json:"publishedAt,omitempty"`
	CreatedAt   string  `json:"createdAt"`
}

func (group cachedTopicGroup) model(latest time.Time) TopicGroupModel {
	return TopicGroupModel{Topic: group.Topic, Count: group.Count, LatestAt: latest, Items: cachedItemsTopic(group.Items)}
}

func (group cachedEventGroup) model(latest time.Time) EventGroupModel {
	topics := group.Topics
	if topics == nil {
		topics = []string{}
	}
	entities := group.Entities
	if entities == nil {
		entities = []string{}
	}
	return EventGroupModel{
		EventID: group.EventID, Count: group.Count, LatestAt: latest,
		Title: group.Title, Summary: group.Summary, Source: group.Source, PublishedAt: group.PublishedAt,
		Topics: topics, Entities: entities, Items: cachedItemsEvent(group.Items),
	}
}

func cachedItemsTopic(items []cachedItem) []TopicItemModel {
	out := make([]TopicItemModel, 0, len(items))
	for _, item := range items {
		created, _ := time.Parse(time.RFC3339Nano, item.CreatedAt)
		out = append(out, TopicItemModel{
			ID: item.ProcessedID, ItemMetaID: item.ItemMetaID, Title: item.Title,
			Summary: item.Summary, Source: item.Source, PublishedAt: item.PublishedAt, CreatedAt: created,
		})
	}
	return out
}

func cachedItemsEvent(items []cachedItem) []EventGroupItemModel {
	out := make([]EventGroupItemModel, 0, len(items))
	for _, item := range items {
		created, _ := time.Parse(time.RFC3339Nano, item.CreatedAt)
		out = append(out, EventGroupItemModel{
			ID: item.ProcessedID, ItemMetaID: item.ItemMetaID, Title: item.Title,
			Summary: item.Summary, Source: item.Source, PublishedAt: item.PublishedAt, CreatedAt: created,
		})
	}
	return out
}

func topicCachePayload(groups []TopicGroupModel) []cachedTopicGroup {
	out := make([]cachedTopicGroup, len(groups))
	for i, group := range groups {
		out[i] = cachedTopicGroup{
			Topic: group.Topic, Count: group.Count, LatestAt: contract.FormatDateTime(group.LatestAt.UTC()),
			Items: cacheItemsFromTopic(group.Items),
		}
	}
	return out
}

func eventCachePayload(groups []EventGroupModel) []cachedEventGroup {
	out := make([]cachedEventGroup, len(groups))
	for i, group := range groups {
		out[i] = cachedEventGroup{
			EventID: group.EventID, Count: group.Count, LatestAt: contract.FormatDateTime(group.LatestAt.UTC()),
			Title: group.Title, Summary: group.Summary, Source: group.Source, PublishedAt: group.PublishedAt,
			Topics: group.Topics, Entities: group.Entities, Items: cacheItemsFromEvent(group.Items),
		}
	}
	return out
}

func cacheItemsFromTopic(items []TopicItemModel) []cachedItem {
	out := make([]cachedItem, len(items))
	for i, item := range items {
		out[i] = cachedItem{
			ProcessedID: item.ID, ItemMetaID: item.ItemMetaID, Title: item.Title, Summary: item.Summary,
			Source: item.Source, PublishedAt: item.PublishedAt, CreatedAt: contract.FormatDateTime(item.CreatedAt.UTC()),
		}
	}
	return out
}

func cacheItemsFromEvent(items []EventGroupItemModel) []cachedItem {
	out := make([]cachedItem, len(items))
	for i, item := range items {
		out[i] = cachedItem{
			ProcessedID: item.ID, ItemMetaID: item.ItemMetaID, Title: item.Title, Summary: item.Summary,
			Source: item.Source, PublishedAt: item.PublishedAt, CreatedAt: contract.FormatDateTime(item.CreatedAt.UTC()),
		}
	}
	return out
}
