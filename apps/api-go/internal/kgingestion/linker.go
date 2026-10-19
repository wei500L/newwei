package kgingestion

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgereview"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// The entity-linking step has its own defaults in
// knowledge-graph.ingestion.service.ts.
const (
	defaultMaxEntitiesPerArticle    = 20
	defaultMinEntityConfidence      = 0.5
	entityCreationConfidenceFloor   = 0.85
	disambiguationTask              = "kg_entity_disambiguation"
	disambiguationSchema            = "kg_entity_disambiguation"
	disambiguationMaxTokens         = 160
	disambiguationTimeout           = 45 * time.Second
	disambiguationRetries           = 1
	disambiguationContextMaxUTF16   = 4_000
	disambiguationMaxCandidatesLow  = 2
	disambiguationMaxCandidatesHigh = 20
	disambiguationDefaultCandidates = 5

	// selfCandidateIDPrefix marks a candidate this article is about to create.
	// The model sees an opaque id and the linker maps it back to the pending
	// entity.
	selfCandidateIDPrefix = "self:"
)

// mention is one parsed article entity mention.
type mention struct {
	Name       string
	Type       string
	Confidence float64
}

// pendingEntity is an entity this article created. Later mentions in the same
// article can match it through its alias keys, which is what the NestJS
// candidate query sees when it runs after the earlier upsert.
type pendingEntity struct {
	name       string
	entityType string
	aliasKeys  map[string]bool
	id         string
}

// candidateRef is one candidate shown to the disambiguation model.
type candidateRef struct {
	id   string
	name string
	typ  string
}

// entityResolution is the pre-transaction decision for one mention.
type entityResolution struct {
	mention   mention
	entityID  string
	selfIndex int
}

// Linker resolves article entity mentions to graph entities and writes the
// ArticleEntityLink rows.
type Linker struct {
	db        *sql.DB
	completer publicportal.KGCompleter
	observer  publicportal.KGCompletionObserver
	now       func() time.Time
	logger    *log.Logger
}

// NewLinker builds the linking step on the shared MySQL pool.
func NewLinker(
	db *sql.DB,
	completer publicportal.KGCompleter,
	observer publicportal.KGCompletionObserver,
	now func() time.Time,
	logger *log.Logger,
) *Linker {
	if now == nil {
		now = time.Now
	}
	return &Linker{db: db, completer: completer, observer: observer, now: now, logger: logger}
}

// Link reproduces linkArticleEntities. Candidate lookup and disambiguation run
// before the transaction opens (O1); the transaction only creates the missing
// entities and inserts the links. A model failure degrades to the first
// candidate, exactly like KnowledgeGraphEntityDisambiguationService, which
// swallows the error and returns null.
func (l *Linker) Link(
	ctx context.Context,
	orgID string,
	articleID string,
	entities json.RawMessage,
	settings Settings,
	contextText string,
) (int, error) {
	if l == nil || l.db == nil {
		return 0, errors.New("kgingestion: mysql is not configured")
	}
	mentions := parseEntityMentions(entities)
	filtered := make([]mention, 0, len(mentions))
	for _, entry := range mentions {
		if entry.Confidence < defaultMinEntityConfidence {
			continue
		}
		filtered = append(filtered, entry)
		if len(filtered) == defaultMaxEntitiesPerArticle {
			break
		}
	}
	if len(filtered) == 0 {
		return 0, nil
	}

	contextTrimmed := knowledgegraph.TrimSpace(contextText)
	disambiguationContext := truncateUTF16(contextTrimmed, disambiguationContextMaxUTF16)
	maxCandidates := clampInt(settings.EntityDisambiguationMaxCandidates,
		disambiguationMaxCandidatesLow, disambiguationMaxCandidatesHigh, disambiguationDefaultCandidates)

	pending := make([]pendingEntity, 0, len(filtered))
	resolutions := make([]entityResolution, 0, len(filtered))
	for _, entry := range filtered {
		entityType := knowledgereview.NormalizeEntityType(entry.Type)
		dbCandidates, err := knowledgegraph.ListEntityCandidates(ctx, l.db, orgID, entry.Name, entityType)
		if err != nil {
			return 0, err
		}
		candidates := make([]candidateRef, 0, len(dbCandidates)+len(pending))
		for _, candidate := range dbCandidates {
			candidates = append(candidates, candidateRef{id: candidate.ID, name: candidate.Name, typ: candidate.Type})
		}
		mentionKeys := knowledgegraph.NormalizeSearchKeys(entry.Name)
		for index, entity := range pending {
			if entity.entityType != entityType {
				continue
			}
			if !intersectsSearchKeys(mentionKeys, entity.aliasKeys) {
				continue
			}
			candidates = append(candidates, candidateRef{
				id:   selfCandidateIDPrefix + strconv.Itoa(index),
				name: entity.name,
				typ:  entity.entityType,
			})
		}

		selected := -1
		if len(candidates) > 0 {
			selected = 0
		}
		if selected >= 0 && shouldDisambiguateMention(settings, contextTrimmed, entry.Confidence, len(candidates)) {
			limit := len(candidates)
			if limit > maxCandidates {
				limit = maxCandidates
			}
			picked := l.chooseEntityID(ctx, orgID, entry, entityType, disambiguationContext, candidates[:limit])
			if picked != "" {
				for index, candidate := range candidates {
					if candidate.id == picked {
						selected = index
						break
					}
				}
			}
		}

		resolution := entityResolution{mention: entry, selfIndex: -1}
		switch {
		case selected >= 0:
			chosen := candidates[selected]
			if index, ok := parseSelfCandidateID(chosen.id); ok {
				resolution.selfIndex = index
			} else {
				resolution.entityID = chosen.id
			}
		case shouldCreateEntity(entry.Confidence, entry.Name):
			resolution.selfIndex = len(pending)
			canonicalName := knowledgegraph.CollapseEntityName(entry.Name)
			pending = append(pending, pendingEntity{
				name:       canonicalName,
				entityType: entityType,
				aliasKeys:  entityAliasKeys(canonicalName, entityType),
			})
		default:
			continue
		}
		resolutions = append(resolutions, resolution)
	}
	if len(resolutions) == 0 {
		return 0, nil
	}

	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := l.now().UTC().Truncate(time.Millisecond)
	for index := range pending {
		entityID, err := knowledgereview.UpsertEntityTx(ctx, tx, orgID, knowledgereview.EntityRef{
			Name: pending[index].name,
			Type: pending[index].entityType,
		}, "llm", now)
		if err != nil {
			return 0, err
		}
		pending[index].id = entityID
	}

	written := 0
	for _, resolution := range resolutions {
		entityID := resolution.entityID
		if resolution.selfIndex >= 0 {
			entityID = pending[resolution.selfIndex].id
		}
		inserted, err := insertArticleEntityLink(ctx, tx, orgID, articleID, entityID, resolution.mention, now)
		if err != nil {
			return 0, err
		}
		written += inserted
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return written, nil
}

// entityCreateThreshold is max(minConfidence, 0.85).
func entityCreateThreshold() float64 {
	return math.Max(defaultMinEntityConfidence, entityCreationConfidenceFloor)
}

// shouldDisambiguateMention is the NestJS disambiguation gate: the setting is
// on, the context is non-empty, the mention is at or above the creation
// threshold and there is more than one candidate.
func shouldDisambiguateMention(settings Settings, contextText string, confidence float64, candidateCount int) bool {
	return settings.EntityDisambiguationEnabled &&
		knowledgegraph.TrimSpace(contextText) != "" &&
		confidence >= entityCreateThreshold() &&
		candidateCount > 1
}

// shouldCreateEntity is the NestJS creation gate: at or above the creation
// threshold and a name of 2..100 UTF-16 units.
func shouldCreateEntity(confidence float64, name string) bool {
	length := jsStringLength(name)
	return confidence >= entityCreateThreshold() && length >= 2 && length <= 100
}

// intersectsSearchKeys reports whether any lookup key of the mention is a
// stored alias key of the pending entity.
func intersectsSearchKeys(mentionKeys []string, aliasKeys map[string]bool) bool {
	for _, key := range mentionKeys {
		if aliasKeys[key] {
			return true
		}
	}
	return false
}

// entityAliasKeys returns the normalized alias keys upsertEntityAliases writes
// for an entity of this type.
func entityAliasKeys(canonicalName, entityType string) map[string]bool {
	candidates := []string{canonicalName}
	if entityType == "company" {
		candidates = append(candidates, knowledgegraph.CompanyAliasCandidates(canonicalName)...)
	}
	if entityType == "instrument" {
		candidates = append(candidates, knowledgegraph.TickerAliases(canonicalName)...)
	}
	keys := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		alias := knowledgegraph.TrimSpace(candidate)
		if alias == "" {
			continue
		}
		if key := knowledgegraph.NormalizeEntityKey(alias); key != "" {
			keys[key] = true
		}
	}
	return keys
}

func parseSelfCandidateID(value string) (int, bool) {
	if !strings.HasPrefix(value, selfCandidateIDPrefix) {
		return 0, false
	}
	index, err := strconv.Atoi(strings.TrimPrefix(value, selfCandidateIDPrefix))
	if err != nil || index < 0 {
		return 0, false
	}
	return index, true
}

// insertArticleEntityLink inserts one link and skips a duplicate
// (orgId, articleId, entityId) row, matching createMany({skipDuplicates:true}).
func insertArticleEntityLink(
	ctx context.Context,
	tx *sql.Tx,
	orgID, articleID, entityID string,
	entry mention,
	now time.Time,
) (int, error) {
	id, err := knowledgereview.NewRowID()
	if err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx,
		"INSERT IGNORE INTO `ArticleEntityLink` (`id`, `orgId`, `articleId`, `entityId`, `mention`, `confidence`, `source`, `createdAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, 'llm', ?)",
		id, orgID, articleID, entityID, entry.Name, entry.Confidence, now,
	)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(affected), nil
}

// chooseEntityID reproduces KnowledgeGraphEntityDisambiguationService.chooseEntityId:
// a model error or an unparsable response returns "" and keeps the caller's
// first candidate.
func (l *Linker) chooseEntityID(
	ctx context.Context,
	orgID string,
	entry mention,
	entityType string,
	contextText string,
	candidates []candidateRef,
) string {
	if l.completer == nil {
		return ""
	}
	system := strings.Join([]string{
		"You are an entity linking system.",
		"Choose the best matching entity from the candidate list for the given mention, using the provided context.",
		`If none match, return {"entityId": null, "confidence": <0-1>}.`,
		"Return a higher confidence only when the match is clear.",
	}, "\n")

	userParts := []string{
		"Mention: " + entry.Name + " (" + entityType + ")",
		"",
		"Context:",
		contextText,
		"",
		"Candidates (choose entityId):",
	}
	for _, candidate := range candidates {
		userParts = append(userParts, "- "+candidate.id+": "+candidate.name+" ("+candidate.typ+")")
	}

	response, err := l.completer.KGComplete(ctx, publicportal.KGCompletionRequest{
		OrgID:      orgID,
		System:     system,
		User:       strings.Join(userParts, "\n"),
		SchemaName: disambiguationSchema,
		Schema:     json.RawMessage(publicportal.KGEntityDisambiguationSchema),
		MaxTokens:  disambiguationMaxTokens,
		TimeoutMS:  int(disambiguationTimeout / time.Millisecond),
		MaxRetries: disambiguationRetries,
		Metadata: publicportal.KGCompletionMetadata{
			Task:  disambiguationTask,
			OrgID: orgID,
		},
		Observer: l.observer,
	})
	if err != nil {
		l.warn("entity disambiguation failed", orgID, err)
		return ""
	}
	entityID, ok := parseDisambiguationContent(response.Content)
	if !ok {
		return ""
	}
	return entityID
}

// parseDisambiguationContent validates the model response and returns the
// selected id. JSON null and an id outside the candidate list both yield no
// selection.
func parseDisambiguationContent(content string) (string, bool) {
	jsonText, ok := extractJSONObject(content)
	if !ok {
		return "", false
	}
	var document struct {
		EntityID   json.RawMessage `json:"entityId"`
		Confidence json.RawMessage `json:"confidence"`
	}
	if err := json.Unmarshal([]byte(jsonText), &document); err != nil {
		return "", false
	}
	if _, ok := decodeConfidence(document.Confidence); !ok {
		return "", false
	}
	trimmed := bytes.TrimSpace(document.EntityID)
	if bytes.Equal(trimmed, []byte("null")) {
		return "", true
	}
	entityID, ok := decodeJSONString(document.EntityID)
	if !ok {
		return "", false
	}
	return entityID, true
}

// parseEntityMentions reproduces parseEntities: a JSON string is parsed first,
// only arrays survive, and a mention needs a trimmed name, a trimmed type and a
// finite numeric confidence.
func parseEntityMentions(raw json.RawMessage) []mention {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var value json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return parseEntityMentionsValue(value)
}

func parseEntityMentionsValue(value json.RawMessage) []mention {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return nil
		}
		return parseEntityMentionsValue(json.RawMessage(text))
	}
	if trimmed[0] != '[' {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil
	}
	mentions := make([]mention, 0, len(entries))
	for _, entry := range entries {
		object := bytes.TrimSpace(entry)
		if len(object) == 0 || object[0] != '{' {
			continue
		}
		var document struct {
			Name       json.RawMessage `json:"name"`
			Type       json.RawMessage `json:"type"`
			Confidence json.RawMessage `json:"confidence"`
		}
		if err := json.Unmarshal(object, &document); err != nil {
			continue
		}
		name, ok := decodeJSONString(document.Name)
		if !ok {
			continue
		}
		entityType, ok := decodeJSONString(document.Type)
		if !ok {
			continue
		}
		confidence, ok := decodeEntityConfidence(document.Confidence)
		if !ok {
			continue
		}
		name = knowledgegraph.TrimSpace(name)
		entityType = knowledgegraph.TrimSpace(entityType)
		if name == "" || entityType == "" {
			continue
		}
		mentions = append(mentions, mention{Name: name, Type: entityType, Confidence: confidence})
	}
	return mentions
}

// decodeEntityConfidence accepts any finite JSON number. Mention confidence is
// not clamped: the NestJS parser only rejects non-numbers.
func decodeEntityConfidence(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// jsStringLength is String.prototype.length: UTF-16 code units.
func jsStringLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func (l *Linker) warn(message, orgID string, err error) {
	if l == nil || l.logger == nil {
		return
	}
	l.logger.Printf("kgingestion: %s orgId=%s err=%v", message, orgID, err)
}
