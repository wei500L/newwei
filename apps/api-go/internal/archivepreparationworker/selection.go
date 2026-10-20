package archivepreparationworker

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

const (
	maxBaseScan       = 12000
	digestScanBatch   = 400
	calendarScanBatch = 600
)

// selectionState is the per-job scan cursor. NestJS restarts every
// getMissing*ClassificationBatch call from the beginning of the range, so a row
// whose display signals cannot be backfilled is selected again forever (B1).
// Keeping the keyset cursor and the digest scan budget across the loop means the
// whole task scans each article at most once while covering the same digest
// prefix as the original 12000-row cap.
// CandidateReader is the archive candidate/cache surface the scan uses.
type CandidateReader interface {
	RecentFirstBatch(ctx context.Context, orgID string, anchor time.Time, take int) ([]*archivereading.ArchiveRow, error)
	RecentBatch(ctx context.Context, orgID string, anchor time.Time, cursor archivereading.Cursor, take int) ([]*archivereading.ArchiveRow, error)
	RangeBatch(ctx context.Context, orgID string, start, end archivereading.Cursor, cursor *archivereading.Cursor, take int) ([]*archivereading.ArchiveRow, error)
	LoadCached(ctx context.Context, orgID string, lookups []archivereading.ClassificationLookup, embeddingModel, rerankModel *string) (map[string]archivereading.CachedClassification, error)
}

type selectionState struct {
	store  CandidateReader
	models ModelClient
	orgID  string
	scope  string
	anchor time.Time
	month  string

	cursor  *archivereading.Cursor
	scanned int
	done    bool

	embeddingModel *string
	rerankModel    *string
	modelsLoaded   bool

	display *taskDisplay
}

// taskDisplay wraps the task-local ProcessedItem signal cache. It queries the
// stored _id in both its string and ObjectId forms because the archive reference
// carries the hexadecimal string while Mongoose's default _id is an ObjectId.
type taskDisplay struct {
	mongo   *mongo.Database
	signals map[string]archivereading.DisplaySignal
}

func newTaskDisplay(database *mongo.Database) *taskDisplay {
	return &taskDisplay{mongo: database, signals: map[string]archivereading.DisplaySignal{}}
}

func (d *taskDisplay) load(ctx context.Context, orgID string, ids []string) map[string]archivereading.DisplaySignal {
	pending := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		if _, ok := d.signals[id]; !ok {
			pending = append(pending, id)
		}
	}
	if len(pending) == 0 {
		return d.signals
	}
	found := d.query(ctx, orgID, pending)
	for _, id := range pending {
		if signal, ok := found[id]; ok {
			d.signals[id] = signal
		} else {
			d.signals[id] = archivereading.DisplaySignal{Exists: false}
		}
	}
	return d.signals
}

func (d *taskDisplay) query(ctx context.Context, orgID string, ids []string) map[string]archivereading.DisplaySignal {
	out := make(map[string]archivereading.DisplaySignal, len(ids))
	if d.mongo == nil {
		return out
	}
	candidates := make([]any, 0, len(ids)*2)
	seen := make(map[string]struct{}, len(ids)*2)
	for _, id := range ids {
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			candidates = append(candidates, id)
		}
		if objectID, err := bson.ObjectIDFromHex(id); err == nil {
			key := objectID.Hex()
			if _, ok := seen[key]; !ok {
				seen[key] = struct{}{}
				candidates = append(candidates, objectID)
			}
		}
	}
	collection := d.mongo.Collection("processeditems")
	cursor, err := collection.Find(ctx,
		bson.D{
			{Key: "_id", Value: bson.D{{Key: "$in", Value: candidates}}},
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
		},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "result", Value: 1}}),
	)
	if err != nil {
		return out
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var document struct {
			ID     bson.RawValue `bson:"_id"`
			Result bson.RawValue `bson:"result"`
		}
		if cursor.Decode(&document) != nil {
			continue
		}
		_, id := mongoIDFilterValue(document.ID)
		if id == "" {
			continue
		}
		signal := archivereading.DisplaySignal{Exists: true}
		var result bson.D
		if bson.Unmarshal(document.Result.Value, &result) == nil {
			signal = archivereading.ExtractDisplaySignalFromBSON(result)
		}
		out[id] = signal
	}
	return out
}

func (d *taskDisplay) forget(orgID string, ids []string) {
	_ = orgID
	for _, id := range ids {
		delete(d.signals, id)
	}
}

// ensureModels resolves the current embedding/rerank model names once per task
// for cache freshness. A configuration read failure fails the task instead of
// silently treating the cache as fresh.
func (s *selectionState) ensureModels(ctx context.Context) error {
	if s.modelsLoaded {
		return nil
	}
	embedding, err := s.models.RuntimeEmbeddingModel(ctx)
	if err != nil {
		return err
	}
	rerank, err := s.models.RuntimeRerankModel(ctx)
	if err != nil {
		return err
	}
	if embedding.Configured {
		value := embedding.Model
		s.embeddingModel = &value
	}
	if rerank.Configured {
		value := rerank.Model
		s.rerankModel = &value
	}
	s.modelsLoaded = true
	return nil
}

// Next returns up to limit rows that need classification or display backfill.
// hasMore reports whether the task must loop again.
func (s *selectionState) Next(ctx context.Context, limit int) ([]*archivereading.ArchiveRow, bool, error) {
	if limit < 1 {
		limit = 1
	}
	if s.done {
		return nil, false, nil
	}
	if err := s.ensureModels(ctx); err != nil {
		return nil, false, err
	}
	missing := make([]*archivereading.ArchiveRow, 0, limit)

	for !s.done {
		take := digestScanBatch
		if s.scope != "digest" {
			take = calendarScanBatch
		}
		if s.scope == "digest" {
			remaining := maxBaseScan - s.scanned
			if remaining <= 0 {
				s.done = true
				break
			}
			if remaining < take {
				take = remaining
			}
		}
		var batch []*archivereading.ArchiveRow
		var err error
		if s.scope == "digest" {
			if s.cursor == nil {
				batch, err = s.store.RecentFirstBatch(ctx, s.orgID, s.anchor, take)
			} else {
				batch, err = s.store.RecentBatch(ctx, s.orgID, s.anchor, *s.cursor, take)
			}
		} else {
			start, end, rangeErr := resolveMonthRange(s.month)
			if rangeErr != nil {
				return nil, false, rangeErr
			}
			batch, err = s.store.RangeBatch(ctx, s.orgID, start, end, s.cursor, take)
		}
		if err != nil {
			return nil, false, err
		}
		if len(batch) == 0 {
			s.done = true
			break
		}

		lookups := make([]archivereading.ClassificationLookup, 0, len(batch))
		for _, row := range batch {
			lookups = append(lookups, classificationLookup(row))
		}
		cached, err := s.store.LoadCached(ctx, s.orgID, lookups, s.embeddingModel, s.rerankModel)
		if err != nil {
			return nil, false, err
		}
		displayIDs := make([]string, 0, len(batch))
		for _, row := range batch {
			if id := trimmed(row.CleanedMarkdownRef); id != "" {
				displayIDs = append(displayIDs, id)
			}
		}
		signals := s.display.load(ctx, s.orgID, displayIDs)

		for index, row := range batch {
			needs := false
			entry, ok := cached[row.ID]
			if !ok || !entry.Fresh {
				needs = true
			} else if id := trimmed(row.CleanedMarkdownRef); id != "" {
				needs = signals[id].NeedsBackfill()
			}
			if !needs {
				continue
			}
			missing = append(missing, row)
			if len(missing) == limit {
				// Return at the batch size boundary and keep the cursor on the
				// last selected row. The next loop scans strictly after it, so
				// no row is skipped and no earlier row is rescanned.
				position := cursorForRow(row)
				s.cursor = &position
				s.scanned += index + 1
				return missing, true, nil
			}
		}

		s.scanned += len(batch)
		last := batch[len(batch)-1]
		position := cursorForRow(last)
		s.cursor = &position
		if len(batch) < take {
			s.done = true
		}
	}
	return missing, false, nil
}

func cursorForRow(row *archivereading.ArchiveRow) archivereading.Cursor {
	return archivereading.Cursor{ProcessedAt: row.ProcessedAt, ID: row.ID}
}

// classificationLookup builds the cache key from the same normalized text and
// rule context classifyRowsBatch uses.
func classificationLookup(row *archivereading.ArchiveRow) archivereading.ClassificationLookup {
	input := classificationInput(row)
	text := archivereading.BuildClassificationText(input)
	return archivereading.ClassificationLookup{
		ProcessedArticleID: row.ID,
		ArticleID:          row.ArticleID,
		Text:               text,
		TextHash:           archivereading.HashClassificationText(text),
		Rule:               input.Rule,
	}
}

func classificationInput(row *archivereading.ArchiveRow) archivereading.ClassificationTextInput {
	source := row.ArticleSourceLabel
	if row.SourceValid {
		source = row.Source
	}
	topics := archivereading.DecodeStoredStringArray(row.TopicsJSON)
	entities := archivereading.DecodeStoredEntities(row.EntitiesJSON)
	rule := archivereading.ClassifyRuleSignals(archivereading.RuleInput{
		Title:    row.Title,
		Summary:  row.Summary,
		Source:   source,
		Topics:   topics,
		Entities: entities,
		Location: row.Location,
	})
	return archivereading.ClassificationTextInput{
		Title:    row.Title,
		Summary:  row.Summary,
		Source:   source,
		Topics:   topics,
		Entities: entities,
		Location: row.Location,
		Rule:     rule,
	}
}

// resolveMonthRange reproduces ArchiveService.resolveMonthRange (UTC start and
// inclusive end-of-month).
func resolveMonthRange(month string) (archivereading.Cursor, archivereading.Cursor, error) {
	trimmed := trimmed(month)
	var year, monthNumber int
	if len(trimmed) != 7 || trimmed[4] != '-' {
		return archivereading.Cursor{}, archivereading.Cursor{}, fmt.Errorf("archiveCalendar month must be in YYYY-MM format")
	}
	for index, r := range trimmed {
		if index == 4 {
			continue
		}
		if r < '0' || r > '9' {
			return archivereading.Cursor{}, archivereading.Cursor{}, fmt.Errorf("archiveCalendar month must be in YYYY-MM format")
		}
	}
	year = int(trimmed[0]-'0')*1000 + int(trimmed[1]-'0')*100 + int(trimmed[2]-'0')*10 + int(trimmed[3]-'0')
	monthNumber = int(trimmed[5]-'0')*10 + int(trimmed[6]-'0')
	if monthNumber < 1 || monthNumber > 12 {
		return archivereading.Cursor{}, archivereading.Cursor{}, fmt.Errorf("archiveCalendar month must be in YYYY-MM format")
	}
	start := time.Date(year, time.Month(monthNumber), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0).Add(-time.Millisecond)
	return archivereading.Cursor{ProcessedAt: start}, archivereading.Cursor{ProcessedAt: end}, nil
}

func trimmed(value string) string { return strings.TrimSpace(value) }
