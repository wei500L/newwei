package itemsingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// Service is the write-side item service. It keeps the NestJS transaction and
// side-effect order: MySQL commit first, then best-effort audit, then immediate
// outbox delivery, then read-model hydration.
type Service struct {
	db       *sql.DB
	store    *store
	mongo    *mongo.Database
	enqueuer Enqueuer
	hydrator Hydrator
	now      func() time.Time
}

// Options wires the write service.
type Options struct {
	DB       *sql.DB
	Mongo    *mongo.Database
	Enqueuer Enqueuer
	Hydrator Hydrator
	Now      func() time.Time
}

// NewService builds the write service. The database, Mongo and enqueuer
// handles are required by the go mode; tests may supply fakes.
func NewService(opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		db:       opts.DB,
		store:    newStore(opts.DB),
		mongo:    opts.Mongo,
		enqueuer: opts.Enqueuer,
		hydrator: opts.Hydrator,
		now:      now,
	}
}

// Create ports ItemsIngestService.create.
func (s *Service) Create(ctx context.Context, orgID, userID string, input CreateItemInput) (CreateItemResult, error) {
	existing, err := s.store.findItemMetaByExternalID(ctx, orgID, input.ExternalID)
	if err != nil {
		return CreateItemResult{}, err
	}
	if existing != nil {
		if strings.TrimSpace(existing.MongoRef) != "" {
			s.deliverPendingForItemMeta(ctx, orgID, existing.ID)
			return CreateItemResult{Meta: *existing, RawItemID: strings.TrimSpace(existing.MongoRef)}, nil
		}
		payload, err := NormalizeNewsPayload(input.Payload)
		if err != nil {
			return CreateItemResult{}, err
		}
		rawItemID := bson.NewObjectID().Hex()
		var outboxID string
		err = s.inTx(ctx, func(tx *sql.Tx) error {
			claimed, err := claimEmptyRefTx(ctx, tx, orgID, existing.ID, rawItemID)
			if err != nil || !claimed {
				return err
			}
			outboxID, err = insertOutboxTx(ctx, tx, OutboxPayload{
				Type:       "raw_item",
				OrgID:      orgID,
				ItemMetaID: existing.ID,
				RawItemID:  rawItemID,
				Source:     "api",
				Payload:    payload,
			})
			return err
		})
		if err != nil {
			return CreateItemResult{}, err
		}
		if outboxID == "" {
			raced, err := s.store.findItemMetaByID(ctx, orgID, existing.ID)
			if err != nil {
				return CreateItemResult{}, err
			}
			if raced != nil && strings.TrimSpace(raced.MongoRef) != "" {
				s.deliverPendingForItemMeta(ctx, orgID, raced.ID)
			}
			meta := *existing
			if raced != nil {
				meta = *raced
			}
			return CreateItemResult{Meta: meta, RawItemID: strings.TrimSpace(meta.MongoRef)}, nil
		}
		s.deliverNow(ctx, outboxID)
		created := *existing
		created.MongoRef = rawItemID
		return CreateItemResult{Meta: created, RawItemID: rawItemID}, nil
	}

	payload, err := NormalizeNewsPayload(input.Payload)
	if err != nil {
		return CreateItemResult{}, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	status := "pending"
	if input.Status != nil {
		status = *input.Status
	}
	rawItemID := bson.NewObjectID().Hex()
	meta := itemsreading.ItemMetaRow{
		ID:         newRowID(),
		OrgID:      orgID,
		ExternalID: input.ExternalID,
		Name:       input.Name,
		Status:     status,
		MongoRef:   rawItemID,
		Version:    1,
		SortAt:     itemsreading.NewISOTime(now),
		CreatedAt:  itemsreading.NewISOTime(now),
		UpdatedAt:  itemsreading.NewISOTime(now),
	}
	var outboxID string
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if err := insertItemMetaTx(ctx, tx, meta); err != nil {
			return err
		}
		created, err := insertOutboxTx(ctx, tx, OutboxPayload{
			Type:       "raw_item",
			OrgID:      orgID,
			ItemMetaID: meta.ID,
			RawItemID:  rawItemID,
			Source:     "api",
			Payload:    payload,
		})
		outboxID = created
		return err
	})
	if err != nil {
		if isUniqueViolation(err) {
			raced, findErr := s.store.findItemMetaByExternalID(ctx, orgID, input.ExternalID)
			if findErr != nil {
				return CreateItemResult{}, findErr
			}
			if raced != nil {
				if strings.TrimSpace(raced.MongoRef) != "" {
					s.deliverPendingForItemMeta(ctx, orgID, raced.ID)
				}
				return CreateItemResult{Meta: *raced, RawItemID: strings.TrimSpace(raced.MongoRef)}, nil
			}
		}
		return CreateItemResult{}, err
	}

	metadata := mustJSON(buildCreateAuditMetadata(input, payload))
	if err := s.store.insertAuditLog(ctx, orgID, userID, "item", "create", metadata); err != nil {
		log.Printf("itemsingest: item create audit failed orgId=%s itemMetaId=%s: %v", orgID, meta.ID, err)
	}

	s.deliverNow(ctx, outboxID)
	return CreateItemResult{Meta: meta, RawItemID: rawItemID}, nil
}

// Update ports ItemsService.update.
func (s *Service) Update(ctx context.Context, orgID, userID string, input UpdateItemInput) (itemsreading.ItemMetaRow, error) {
	existing, err := s.store.findItemMetaByID(ctx, orgID, input.ID)
	if err != nil {
		return itemsreading.ItemMetaRow{}, err
	}
	if existing == nil {
		return itemsreading.ItemMetaRow{}, itemNotFound()
	}

	var normalized *NormalizedNewsPayload
	if isTruthyJSON(input.Payload) {
		payload, err := NormalizeNewsPayload(input.Payload)
		if err != nil {
			return itemsreading.ItemMetaRow{}, err
		}
		normalized = &payload
	}
	name := existing.Name
	if input.Name != nil {
		name = *input.Name
	}
	status := existing.Status
	if input.Status != nil {
		status = *input.Status
	}

	now := s.now().UTC().Truncate(time.Millisecond)
	var outboxID string
	var updated itemsreading.ItemMetaRow
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		var rawItemID *string
		if normalized != nil {
			value := bson.NewObjectID().Hex()
			rawItemID = &value
		}
		row, err := updateItemMetaTx(ctx, tx, *existing, name, status, rawItemID, now)
		if err != nil {
			return err
		}
		updated = row
		if normalized != nil {
			outboxID, err = insertOutboxTx(ctx, tx, OutboxPayload{
				Type:       "raw_item",
				OrgID:      orgID,
				ItemMetaID: existing.ID,
				RawItemID:  *rawItemID,
				Source:     "graphql",
				Payload:    *normalized,
			})
		}
		return err
	})
	if err != nil {
		return itemsreading.ItemMetaRow{}, err
	}

	if outboxID != "" {
		s.deliverNow(ctx, outboxID)
	}
	if err := s.hydrate(ctx, orgID, existing.ID); err != nil {
		return itemsreading.ItemMetaRow{}, err
	}

	metadata := mustJSON(buildUpdateAuditMetadata(input, normalized))
	if err := s.store.insertAuditLog(ctx, orgID, userID, "item", "update", metadata); err != nil {
		log.Printf("itemsingest: item update audit failed orgId=%s itemMetaId=%s: %v", orgID, existing.ID, err)
	}
	return updated, nil
}

// CreateFromCrawlResult ports ItemsIngestService.createFromCrawlResult.
func (s *Service) CreateFromCrawlResult(ctx context.Context, orgID, userID, crawlResultID string) (itemsreading.ItemMetaRow, error) {
	normalized := strings.TrimSpace(crawlResultID)
	if normalized == "" {
		return itemsreading.ItemMetaRow{}, NewFailure(http.StatusBadRequest, "crawlResultId is required")
	}
	outcomes, err := s.createFromCrawlResults(ctx, orgID, userID, CreateFromCrawlResultsInput{
		CrawlResultIDs: []string{normalized},
	})
	if err != nil {
		return itemsreading.ItemMetaRow{}, err
	}
	if len(outcomes) == 0 || outcomes[0].Err != nil || outcomes[0].Meta == nil {
		if len(outcomes) > 0 && outcomes[0].Err != nil {
			return itemsreading.ItemMetaRow{}, outcomes[0].Err
		}
		return itemsreading.ItemMetaRow{}, crawlResultNotFound()
	}
	return *outcomes[0].Meta, nil
}

// IngestCrawlTaskResults ports CrawlTaskService.ingestResultsToItems.
func (s *Service) IngestCrawlTaskResults(ctx context.Context, orgID, userID, taskID string, opts IngestBatchOptions) (IngestBatchSummary, error) {
	exists, err := s.store.crawlTaskExists(ctx, orgID, taskID)
	if err != nil {
		return IngestBatchSummary{}, err
	}
	if !exists {
		return IngestBatchSummary{}, crawlTaskNotFound()
	}

	after := ""
	if opts.After != nil {
		after = strings.TrimSpace(*opts.After)
	}
	take := 50
	if opts.Limit != nil && !math.IsNaN(*opts.Limit) && !math.IsInf(*opts.Limit, 0) {
		take = int(math.Floor(*opts.Limit))
	}
	if take < 1 {
		take = 1
	}
	if take > 200 {
		take = 200
	}
	onlyMissing := true
	if opts.OnlyMissing != nil {
		onlyMissing = *opts.OnlyMissing
	}

	rows, err := s.store.crawlResultsPage(ctx, taskID, after, take)
	if err != nil {
		return IngestBatchSummary{}, err
	}
	hasMore := len(rows) > take
	page := rows
	if hasMore {
		page = rows[:take]
	}
	summary := IngestBatchSummary{TaskID: taskID, Scanned: float64(len(page)), HasMore: hasMore}

	candidates := page
	if onlyMissing && len(page) > 0 {
		externalIDs := make([]string, 0, len(page))
		for _, row := range page {
			externalIDs = append(externalIDs, "crawlResult:"+row.ID)
		}
		existing, err := s.store.itemMetasByExternalIDs(ctx, orgID, externalIDs)
		if err != nil {
			return IngestBatchSummary{}, err
		}
		withRef := make(map[string]struct{}, len(existing))
		for _, meta := range existing {
			if strings.TrimSpace(meta.MongoRef) != "" {
				withRef[meta.ExternalID] = struct{}{}
			}
		}
		candidates = make([]CrawlResultRow, 0, len(page))
		for _, row := range page {
			if _, skipped := withRef["crawlResult:"+row.ID]; skipped {
				summary.SkippedExisting++
				continue
			}
			candidates = append(candidates, row)
		}
	}
	summary.Attempted = float64(len(candidates))

	if len(candidates) > 0 {
		outcomes, err := s.createFromCrawlResults(ctx, orgID, userID, CreateFromCrawlResultsInput{CrawlResults: candidates})
		if err != nil {
			return IngestBatchSummary{}, err
		}
		for _, outcome := range outcomes {
			if outcome.Err != nil {
				summary.Failed++
				log.Printf("itemsingest: crawl-result ingest failed orgId=%s taskId=%s crawlResultId=%s: %v",
					orgID, taskID, outcome.CrawlResultID, outcome.Err)
				continue
			}
			summary.Ingested++
		}
	}
	if hasMore {
		cursor := page[len(page)-1].ID
		summary.NextCursor = &cursor
	}
	return summary, nil
}

// UpdateCrawlTaskIngest ports CrawlTaskService.updateIngestToItems. The
// items.write requirement is checked after the task lookup and before the
// no-op comparison, exactly like the NestJS service.
func (s *Service) UpdateCrawlTaskIngest(
	ctx context.Context,
	orgID, userID string,
	permissions map[string]bool,
	taskID string,
	enabled bool,
) (*crawlreadtelemetry.CrawlTaskView, error) {
	view, err := s.store.loadCrawlTaskView(ctx, orgID, taskID)
	if err != nil {
		return nil, err
	}
	if view == nil {
		return nil, crawlTaskNotFound()
	}
	if enabled && !permissions[WritePermission] {
		return nil, NewFailure(http.StatusForbidden, "items.write permission is required to enable ingestToItems")
	}

	current := jsonObject(view.Config)
	currentEnabled := false
	if raw, ok := current["ingestToItems"]; ok {
		var value any
		if json.Unmarshal(raw, &value) == nil {
			currentEnabled = value == true
		}
	}
	if enabled == currentEnabled {
		return view, nil
	}

	var next map[string]json.RawMessage
	if current != nil {
		next = make(map[string]json.RawMessage, len(current)+1)
		for key, value := range current {
			next[key] = value
		}
	}
	if enabled {
		if next == nil {
			next = map[string]json.RawMessage{}
		}
		next["ingestToItems"] = json.RawMessage(`true`)
	} else if next != nil {
		delete(next, "ingestToItems")
		if len(next) == 0 {
			next = nil
		}
	}

	var configJSON []byte
	if next != nil {
		configJSON, err = json.Marshal(next)
		if err != nil {
			return nil, err
		}
	}
	if err := s.store.updateCrawlTaskConfig(ctx, orgID, taskID, configJSON); err != nil {
		return nil, err
	}
	if err := s.store.insertAuditLog(ctx, orgID, userID, "crawlTask", "updateIngestToItems",
		mustJSON(struct {
			TaskID  string `json:"taskId"`
			Enabled bool   `json:"enabled"`
		}{TaskID: taskID, Enabled: enabled})); err != nil {
		log.Printf("itemsingest: ingestToItems audit failed orgId=%s taskId=%s: %v", orgID, taskID, err)
	}
	updated, err := s.store.loadCrawlTaskView(ctx, orgID, taskID)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, crawlTaskNotFound()
	}
	return updated, nil
}
