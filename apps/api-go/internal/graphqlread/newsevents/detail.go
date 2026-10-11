package newsevents

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func (s *service) newsEvent(ctx contract.Context) (any, error) {
	if s == nil || s.db == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	id, _ := contract.StringArg(ctx.Args, "id")
	itemsLimit := optionalInt(ctx.Args, "itemsLimit", 50, 1, 200)
	timelineLimit := optionalInt(ctx.Args, "timelineLimit", 200, 1, 2000)
	callCtx := s.call(ctx)
	row, err := s.loadEvent(callCtx, ctx.Identity.OrgID, id)
	if err != nil || row == nil {
		return nil, err
	}
	settings := s.loadSettings(callCtx, ctx.Identity.OrgID)
	window := settings.Backfill
	if settings.Lookback > window {
		window = settings.Lookback
	}
	since := s.clock().Add(-time.Duration(window) * day)
	items, err := s.loadItems(callCtx, row.ID, itemsLimit)
	if err != nil {
		return nil, err
	}
	timeline, err := s.loadTimeline(callCtx, row.ID, &since, timelineLimit)
	if err != nil {
		return nil, err
	}
	heat, err := s.heatMap(callCtx, ctx.Identity.OrgID, []string{row.ID}, []eventRow{*row})
	if err != nil {
		return nil, err
	}
	authority, err := s.authorityMap(callCtx, ctx.Identity.OrgID, []string{row.ID}, 45)
	if err != nil {
		return nil, err
	}
	metaIDs, err := s.itemMetaIDs(callCtx, items)
	if err != nil {
		return nil, err
	}
	distribution, err := s.categoryDistribution(callCtx, ctx.Identity.OrgID, []string{row.ID})
	if err != nil {
		return nil, err
	}
	model := scoredEvent{row: *row, heat: heat[row.ID], authority: authority[row.ID]}.model(true)
	mappedItems := make([]NewsEventItemModel, 0, len(items))
	for _, item := range items {
		mappedItems = append(mappedItems, mapItem(item, metaIDs))
	}
	bag := timelineFromMetadata(row.Metadata)
	mappedTimeline := make([]NewsEventTimelineEntryModel, 0, len(timeline))
	for _, entry := range timeline {
		mappedTimeline = append(mappedTimeline, mapTimeline(entry, bag))
	}
	model.Items = &mappedItems
	model.Timeline = &mappedTimeline
	entries := distribution[row.ID]
	if entries == nil {
		entries = []categoryEntry{}
	}
	model.CategoryDistribution = entries
	return model, nil
}

func mapItem(item itemRow, metaIDs map[string]string) NewsEventItemModel {
	var meta *string
	if item.ProcessedItemID != nil {
		if value := metaIDs[*item.ProcessedItemID]; value != "" {
			copy := value
			meta = &copy
		}
	}
	return NewsEventItemModel{
		ID:                 item.ID,
		EventID:            item.EventID,
		ProcessedArticleID: item.ProcessedArticleID,
		ItemMetaID:         meta,
		ProcessedItemID:    item.ProcessedItemID,
		Similarity:         item.Similarity,
		AssignedBy:         item.AssignedBy,
		CreatedAt:          item.CreatedAt,
		ProcessedArticle: NewsEventProcessedArticleModel{
			ID:          item.ArticleRowID,
			ArticleID:   item.ArticleID,
			Title:       item.Title,
			Summary:     item.Summary,
			PublishedAt: item.PublishedAt,
			Language:    item.Language,
			ProcessedAt: item.ProcessedAt,
			Article: NewsEventArticleModel{
				ID:          item.ArticlePK,
				URL:         item.URL,
				SourceLabel: item.SourceLabel,
				CrawlAt:     item.CrawlAt,
			},
		},
	}
}

func mapTimeline(entry timelineRow, bag timelineBag) NewsEventTimelineEntryModel {
	meta := timelineEntryMeta(bag, entry.BucketStart)
	return NewsEventTimelineEntryModel{
		ID:                   entry.ID,
		EventID:              entry.EventID,
		BucketStart:          entry.BucketStart,
		Title:                entry.Title,
		Summary:              entry.Summary,
		KeyPoints:            rawOrNil(entry.KeyPoints),
		ReferencedArticleIDs: rawOrNil(entry.ReferencedArticleIDs),
		CategoryPath:         meta.CategoryPath,
		CategoryConfidence:   meta.CategoryConfidence,
		Tentative:            meta.Tentative,
		Anchor:               meta.Anchor,
		CreatedAt:            entry.CreatedAt,
		UpdatedAt:            entry.UpdatedAt,
	}
}

func rawOrNil(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	return append([]byte(nil), raw...)
}

func (s *service) itemMetaIDs(ctx context.Context, items []itemRow) (map[string]string, error) {
	out := map[string]string{}
	if s.mongo == nil {
		return out, nil
	}
	ids := make([]bson.ObjectID, 0, len(items))
	for _, item := range items {
		if item.ProcessedItemID == nil {
			continue
		}
		objectID, err := bson.ObjectIDFromHex(strings.TrimSpace(*item.ProcessedItemID))
		if err != nil {
			continue
		}
		ids = append(ids, objectID)
	}
	if len(ids) == 0 {
		return out, nil
	}
	cursor, err := s.mongo.Collection("processeditems").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "itemMetaId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		id := stringifyID(doc["_id"])
		meta, _ := doc["itemMetaId"].(string)
		meta = strings.TrimSpace(meta)
		if id == "" || meta == "" {
			continue
		}
		if _, exists := out[id]; exists {
			continue
		}
		out[id] = meta
	}
	return out, cursor.Err()
}

func (s *service) categoryDistribution(ctx context.Context, orgID string, eventIDs []string) (map[string][]categoryEntry, error) {
	result := map[string][]categoryEntry{}
	for _, id := range eventIDs {
		result[id] = []categoryEntry{}
	}
	if len(eventIDs) == 0 || s.db == nil {
		return result, nil
	}
	since := s.clock().Add(-90 * day)
	rows, err := s.loadCategoryRows(ctx, orgID, eventIDs, since)
	if err != nil {
		return nil, err
	}
	classes := s.processedClasses(ctx, rows)
	counts := map[string]map[string]int{}
	for _, id := range eventIDs {
		counts[id] = map[string]int{}
	}
	for _, row := range rows {
		bucket := counts[row.EventID]
		if bucket == nil {
			continue
		}
		class := classes[row.ProcessedItemID]
		legacy := class.legacy
		if legacy == nil {
			legacy = normalizeLegacyCategory(row.Category)
		}
		path := class.path
		if path == nil {
			path = legacy
		}
		key := "uncategorized"
		if path != nil && *path != "" {
			key = *path
		}
		bucket[key]++
	}
	for _, id := range eventIDs {
		bucket := counts[id]
		total := 0
		for _, count := range bucket {
			total += count
		}
		if total <= 0 {
			result[id] = []categoryEntry{}
			continue
		}
		entries := make([]categoryEntry, 0, len(bucket))
		for path, count := range bucket {
			head := path
			if slash := strings.Index(path, "/"); slash >= 0 {
				head = path[:slash]
			}
			share := float64(roundHalfAway(float64(count)/float64(total)*10_000)) / 10_000
			entries = append(entries, categoryEntry{
				CategoryPath:   path,
				LegacyCategory: normalizeLegacyCategory(head),
				Count:          count,
				Share:          share,
			})
		}
		sort.SliceStable(entries, func(i, j int) bool {
			if entries[i].Count != entries[j].Count {
				return entries[i].Count > entries[j].Count
			}
			return entries[i].CategoryPath < entries[j].CategoryPath
		})
		if len(entries) > 16 {
			entries = entries[:16]
		}
		result[id] = entries
	}
	return result, nil
}

type processedClass struct {
	legacy *string
	path   *string
}

func (s *service) processedClasses(ctx context.Context, rows []categoryRow) map[string]processedClass {
	out := map[string]processedClass{}
	if s.mongo == nil {
		return out
	}
	ids := make([]bson.ObjectID, 0, len(rows))
	seen := map[string]struct{}{}
	for _, row := range rows {
		if row.ProcessedItemID == "" {
			continue
		}
		if _, ok := seen[row.ProcessedItemID]; ok {
			continue
		}
		seen[row.ProcessedItemID] = struct{}{}
		objectID, err := bson.ObjectIDFromHex(row.ProcessedItemID)
		if err != nil {
			continue
		}
		ids = append(ids, objectID)
	}
	if len(ids) == 0 {
		return out
	}
	cursor, err := s.mongo.Collection("processeditems").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "result", Value: 1}}))
	if err != nil {
		return out
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		id := stringifyID(doc["_id"])
		if id == "" {
			continue
		}
		out[id] = classFromResult(doc["result"])
	}
	return out
}

func classFromResult(value any) processedClass {
	record, ok := value.(bson.M)
	if !ok {
		if generic, isMap := value.(map[string]any); isMap {
			record = bson.M(generic)
		} else {
			return processedClass{}
		}
	}
	legacy := ""
	if text, ok := record["category"].(string); ok {
		legacy = text
	}
	if text, ok := record["legacy_category"].(string); ok && normalizeLegacyCategory(legacy) == nil {
		legacy = text
	}
	pathText := ""
	if text, ok := record["category_path"].(string); ok {
		pathText = text
	}
	if text, ok := record["categoryPath"].(string); ok && normalizeCategoryPath(pathText) == nil {
		pathText = text
	}
	return processedClass{legacy: normalizeLegacyCategory(legacy), path: normalizeCategoryPath(pathText)}
}

func stringifyID(value any) string {
	switch typed := value.(type) {
	case bson.ObjectID:
		return typed.Hex()
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}
