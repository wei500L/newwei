package archivepreparationworker

import (
	"context"
	"encoding/json"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
)

// backfillTarget is one ProcessedItem that needs its classification signals.
type backfillTarget struct {
	ProcessedItemID string
	SourceURL       string
	SourceLabel     string
}

// processedItemDocument is one result-bearing document with the original _id
// value type preserved for the update filter.
type processedItemDocument struct {
	Filter any
	ID     string
	Result json.RawMessage
}

// backfillMissingProcessedItemDisplaySignals reproduces
// NewsPipelineService.backfillProcessedItemClassificationSignals and the archive
// service's target selection. Unknown result members are preserved.
func (p *Processor) backfillMissingProcessedItemDisplaySignals(ctx context.Context, orgID string, rows []*archivereading.ArchiveRow, session *newsclassifier.Session, display *taskDisplay) error {
	if len(rows) == 0 || session == nil {
		return nil
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if id := trimmed(row.CleanedMarkdownRef); id != "" {
			ids = append(ids, id)
		}
	}
	signals := display.load(ctx, orgID, ids)
	targets := make([]backfillTarget, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, row := range rows {
		processedItemID := trimmed(row.CleanedMarkdownRef)
		if processedItemID == "" {
			continue
		}
		if _, ok := seen[processedItemID]; ok {
			continue
		}
		if !signals[processedItemID].NeedsBackfill() {
			continue
		}
		seen[processedItemID] = struct{}{}
		sourceLabel := trimmed(row.Source)
		if sourceLabel == "" {
			sourceLabel = trimmed(row.ArticleSourceLabel)
		}
		targets = append(targets, backfillTarget{
			ProcessedItemID: processedItemID,
			SourceURL:       trimmed(row.ArticleURL),
			SourceLabel:     sourceLabel,
		})
	}
	if len(targets) == 0 {
		return nil
	}

	documents, err := p.loadProcessedItemResults(ctx, orgID, targets)
	if err != nil {
		return err
	}
	byID := make(map[string]processedItemDocument, len(documents))
	for _, document := range documents {
		byID[document.ID] = document
	}

	for _, target := range targets {
		document, ok := byID[target.ProcessedItemID]
		if !ok {
			continue
		}
		cleaned, ok := newsclassifier.ParseStoredCleanedNews(document.Result)
		if !ok {
			continue
		}
		if cleaned.ContentType != "" && (cleaned.CategoryPath != "" || cleaned.CategoryMethod != "") {
			continue
		}
		sourceLabel := target.SourceLabel
		if sourceLabel == "" {
			sourceLabel = trimmed(cleaned.Source)
		}
		cleaned.ResolveContentType(target.SourceURL, sourceLabel)
		result, err := session.Classify(ctx, orgID, cleaned.ClassifierInput(), newsclassifier.Options{
			SourceURL: target.SourceURL, SourceLabel: sourceLabel,
		})
		if err != nil {
			return err
		}
		updated, err := cleaned.ApplyToCleanedNews(result)
		if err != nil {
			return err
		}
		stored, err := jsonToBSONDocument(updated)
		if err != nil {
			return err
		}
		hasLocation := newsclassifier.HasLocation(updated)
		collection := p.mongo.Collection("processeditems")
		if _, err := collection.UpdateOne(ctx,
			bson.D{
				{Key: "_id", Value: document.Filter},
				{Key: "orgId", Value: orgID},
			},
			bson.D{{Key: "$set", Value: bson.D{
				{Key: "result", Value: stored},
				{Key: "hasLocation", Value: hasLocation},
			}}},
		); err != nil {
			return err
		}
	}
	return nil
}

// loadProcessedItemResults reads the completed documents in one query, matching
// both string and ObjectId _id forms.
func (p *Processor) loadProcessedItemResults(ctx context.Context, orgID string, targets []backfillTarget) ([]processedItemDocument, error) {
	if p.mongo == nil || len(targets) == 0 {
		return nil, nil
	}
	candidates := make([]any, 0, len(targets)*2)
	seen := make(map[string]struct{}, len(targets)*2)
	for _, target := range targets {
		if _, ok := seen[target.ProcessedItemID]; !ok {
			seen[target.ProcessedItemID] = struct{}{}
			candidates = append(candidates, target.ProcessedItemID)
		}
		if objectID, err := bson.ObjectIDFromHex(target.ProcessedItemID); err == nil {
			key := objectID.Hex()
			if _, ok := seen[key]; !ok {
				seen[key] = struct{}{}
				candidates = append(candidates, objectID)
			}
		}
	}
	cursor, err := p.mongo.Collection("processeditems").Find(ctx,
		bson.D{
			{Key: "_id", Value: bson.D{{Key: "$in", Value: candidates}}},
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
		},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "result", Value: 1}}),
	)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]processedItemDocument, 0, len(targets))
	for cursor.Next(ctx) {
		var document struct {
			ID     bson.RawValue `bson:"_id"`
			Result bson.RawValue `bson:"result"`
		}
		if cursor.Decode(&document) != nil {
			continue
		}
		filter, id := mongoIDFilterValue(document.ID)
		if id == "" {
			continue
		}
		resultJSON, err := bsonValueToJSON(document.Result)
		if err != nil || len(resultJSON) == 0 {
			continue
		}
		out = append(out, processedItemDocument{Filter: filter, ID: id, Result: resultJSON})
	}
	return out, cursor.Err()
}
