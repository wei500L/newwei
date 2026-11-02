package situationmonitors

import (
	"context"
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

// modelGateway is the slice of *llmembed.Client the monitor write and preview
// paths use. It is an interface only so unit tests can drive ranking, rerank and
// the reported model names without a model gateway.
type modelGateway interface {
	Embed(ctx context.Context, orgID string, texts []string) ([][]float64, string, error)
	Rerank(ctx context.Context, orgID, query string, documents []string) ([]llmembed.Hit, error)
	RuntimeRerankModel(ctx context.Context) (string, bool)
}

// Service 写同一张 SituationMonitorMonitor。监控 HTTP 的遗留迁移会尝试
// embedding；失败时向量为空，请求仍然成功。订阅路径自己的迁移不从这里替换。
type Service struct {
	db       *sql.DB
	embed    modelGateway
	geocoder LocationGeocoder
}

// NewService wires the monitor store, the model gateway and the shared
// geocoder. The HTTP preview/create/update paths must pass a production
// *geocoding.Client; read-only projections may pass nil because List never
// resolves a location.
func NewService(db *sql.DB, geocoder LocationGeocoder) *Service {
	return &Service{
		db:       db,
		embed:    llmembed.NewClient(db),
		geocoder: geocoder,
	}
}

func (s *Service) List(ctx context.Context, orgID, userID string) ([]storedMonitor, error) {
	out := make([]storedMonitor, 0)
	err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureLegacyMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		rows, err := s.listRows(ctx, conn, orgID, userID)
		if err != nil {
			return err
		}
		out = make([]storedMonitor, 0, len(rows))
		for _, row := range rows {
			out = append(out, mapRow(row))
		}
		return nil
	})
	return out, err
}

func (s *Service) Create(ctx context.Context, orgID, userID string, input monitorWrite) (storedMonitor, error) {
	var out storedMonitor
	err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureLegacyMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		count, err := s.countManual(ctx, conn, orgID, userID)
		if err != nil {
			return err
		}
		if count >= maxManualMonitors {
			return errLimitReached
		}
		payload, err := s.buildPayload(ctx, orgID, input, "manual")
		if err != nil {
			return err
		}
		created, err := s.insertMonitor(ctx, conn, orgID, userID, "manual", payload, nowMillis())
		if err != nil {
			return err
		}
		out = mapRow(created)
		return s.reconcileContentSubscriptionSync(ctx, conn, orgID, userID)
	})
	return out, err
}

func (s *Service) Update(ctx context.Context, orgID, userID, id string, patch monitorPatch) (storedMonitor, error) {
	var out storedMonitor
	err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureLegacyMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		existing, err := s.findRow(ctx, conn, orgID, userID, id)
		if err != nil {
			return err
		}
		if existing == nil {
			return errMonitorMissing
		}
		if existing.Kind == "system_sync" && patch.rejectsSystemSync() {
			return errSystemReadOnly
		}
		merged := mergePatch(*existing, patch)
		payload, err := s.buildPayload(ctx, orgID, merged, existing.Kind)
		if err != nil {
			return err
		}
		if patch.Enabled.set {
			payload.Enabled = patch.Enabled.value
		}
		updated, err := s.updateMonitor(ctx, conn, orgID, userID, existing.ID, payload)
		if err != nil {
			return err
		}
		out = mapRow(updated)
		return s.reconcileContentSubscriptionSync(ctx, conn, orgID, userID)
	})
	return out, err
}

func (s *Service) Delete(ctx context.Context, orgID, userID, id string) error {
	return s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureLegacyMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		existing, err := s.findRow(ctx, conn, orgID, userID, id)
		if err != nil {
			return err
		}
		if existing == nil {
			return nil
		}
		if existing.Kind == "system_sync" {
			return errSystemDelete
		}
		if err := s.deleteMonitor(ctx, conn, orgID, userID, existing.ID); err != nil {
			return err
		}
		return s.reconcileContentSubscriptionSync(ctx, conn, orgID, userID)
	})
}

func (s *Service) buildPayload(ctx context.Context, orgID string, input monitorWrite, kind string) (persistedMonitor, error) {
	name := normalizeName(input.Name)
	rawKeywords := normalizeKeywordList(input.RawKeywords)
	approvedTopics := normalizeStringList(input.ApprovedTopics, maxApprovedSuggestions)
	approvedEntities := normalizeStringList(input.ApprovedEntities, maxApprovedSuggestions)
	approvedSources := normalizeStringList(input.ApprovedSources, maxApprovedSuggestions)
	approvedGeos := normalizeStringList(input.ApprovedGeos, maxApprovedSuggestions)
	lexicalSource := input.ApprovedLexical
	if lexicalSource == nil {
		lexicalSource = rawKeywords
	}
	approvedLexical := normalizeStringList(lexicalSource, maxApprovedTerms)
	rejected := rejectedState{
		Topics:       lowerList(input.RejectedTopics, maxApprovedSuggestions),
		Entities:     lowerList(input.RejectedEntities, maxApprovedSuggestions),
		LexicalTerms: lowerList(input.RejectedLexical, maxApprovedTerms),
	}
	color := sql.NullString{}
	if normalized, ok := normalizeColor(input.Color); ok {
		color = sql.NullString{String: normalized, Valid: true}
	}
	loc := s.resolveLocation(ctx, input.Location)
	if name == "" {
		return persistedMonitor{}, errNameRequired
	}
	if kind == "manual" && len(rawKeywords) == 0 {
		return persistedMonitor{}, errKeywordRequired
	}
	embedding := s.buildQueryEmbedding(ctx, orgID, buildQueryText(name, rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexical, loc), "monitor-query-embedding")
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	return persistedFromParts(name, enabled, color, rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexical, rejected, loc, embedding, nowMillis()), nil
}
