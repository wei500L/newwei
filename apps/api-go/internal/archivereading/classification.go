package archivereading

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"strings"
)

const (
	classificationTaxonomyVersion = "archive-vertical-v2"
	classificationPipelineVersion = "archive-hybrid-v2"
	classificationTextVersion     = "archive-text-v2"
	scoreTieEpsilon               = 1e-9
	strongRuleConflictMaxScore    = 0.62
	strongRuleConflictMaxGap      = 0.08
	semanticMinConfidence         = 0.55
	lowConfidenceFusedScore       = 0.5
)

var classificationEmptyText = strings.Join([]string{
	"Title: none",
	"Summary: none",
	"Topics: none",
	"Entities: none",
	"Location: none",
	"Source: none",
	"Country hint: none",
	"Region hint: OTHER",
}, "\n")

// scoreVector is a fixed-order five-vertical score map. A typed array keeps the
// stored JSON parser, tie-break and detail projection on one representation.
type scoreVector [5]float64

func verticalIndex(vertical Vertical) int {
	for index, candidate := range VerticalOrder {
		if candidate == vertical {
			return index
		}
	}
	return -1
}

func (s scoreVector) get(vertical Vertical) float64 {
	index := verticalIndex(vertical)
	if index < 0 {
		return 0
	}
	return s[index]
}

// verticalScoresJSON is the stored score document. Members are pointers so a
// missing/null score becomes 0 exactly like parseScoreMap.
type verticalScoresJSON struct {
	EastSea         *float64 `json:"EAST_SEA"`
	SouthSea        *float64 `json:"SOUTH_SEA"`
	WestFront       *float64 `json:"WEST_FRONT"`
	ForeignAffairs  *float64 `json:"FOREIGN_AFFAIRS"`
	DomesticAffairs *float64 `json:"DOMESTIC_AFFAIRS"`
}

func parseScoreVector(raw []byte) scoreVector {
	var stored verticalScoresJSON
	if len(raw) == 0 || json.Unmarshal(raw, &stored) != nil {
		return scoreVector{}
	}
	values := []*float64{stored.EastSea, stored.SouthSea, stored.WestFront, stored.ForeignAffairs, stored.DomesticAffairs}
	var out scoreVector
	for index, value := range values {
		if value == nil || !isFinite(*value) {
			continue
		}
		out[index] = clamp01(*value)
	}
	return out
}

// classificationTextInput is the normalized article data the cache text hash is
// built from.
type classificationTextInput struct {
	Title    string
	Summary  string
	Source   string
	Topics   []string
	Entities []Entity
	Location string
	Rule     RuleSignals
}

// buildClassificationText reproduces ArchiveClassificationService
// buildClassificationText: trimmed values, de-duplicated topics/entities in
// first-seen order, a country hint from the rule label or code, and the
// unconditional region hint. The SHA256 of this text is the cache key.
func buildClassificationText(input classificationTextInput) string {
	title := strings.TrimSpace(input.Title)
	summary := strings.TrimSpace(input.Summary)
	topics := uniqueTrimmed(input.Topics)
	entities := uniqueEntityNames(input.Entities)
	location := strings.TrimSpace(input.Location)
	source := strings.TrimSpace(input.Source)
	countryHint := strings.TrimSpace(input.Rule.CountryLabel)
	if countryHint == "" && input.Rule.CountryCode != nil {
		countryHint = *input.Rule.CountryCode
	}
	regionHint := string(input.Rule.Region)

	lines := make([]string, 0, 8)
	if title != "" {
		lines = append(lines, "Title: "+title)
	}
	if summary != "" {
		lines = append(lines, "Summary: "+summary)
	}
	if len(topics) > 0 {
		lines = append(lines, "Topics: "+strings.Join(topics, " | "))
	}
	if len(entities) > 0 {
		lines = append(lines, "Entities: "+strings.Join(entities, " | "))
	}
	if location != "" {
		lines = append(lines, "Location: "+location)
	}
	if source != "" {
		lines = append(lines, "Source: "+source)
	}
	if countryHint != "" {
		lines = append(lines, "Country hint: "+countryHint)
	}
	if regionHint != "" {
		lines = append(lines, "Region hint: "+regionHint)
	}
	if len(lines) == 0 {
		return classificationEmptyText
	}
	return strings.Join(lines, "\n")
}

func hashClassificationText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func uniqueTrimmed(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func uniqueEntityNames(entities []Entity) []string {
	out := make([]string, 0, len(entities))
	seen := make(map[string]struct{}, len(entities))
	for _, entity := range entities {
		trimmed := strings.TrimSpace(entity.Name)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// storedClassificationRow is one ArchiveArticleClassification row.
type storedClassificationRow struct {
	ProcessedArticleID        string
	ArticleID                 string
	Region                    string
	Vertical                  string
	RuleScores                []byte
	EmbeddingScores           []byte
	RerankScores              []byte
	FusedScores               []byte
	ClassificationTextHash    string
	ClassificationTextVersion string
	TaxonomyVersion           string
	PipelineVersion           string
	EmbeddingModel            string
	RerankModel               string
}

// classificationResult is the cached classification plus its current decision.
type classificationResult struct {
	ProcessedArticleID string
	Region             Region
	Vertical           Vertical
	DecisionReason     DecisionReason
	RuleScores         scoreVector
	EmbeddingScores    scoreVector
	RerankScores       scoreVector
	FusedScores        scoreVector
	CountryLabel       string
	EntityTags         []string
	TaxonomyVersion    string
	PipelineVersion    string
	EmbeddingModel     string
	RerankModel        string
}

// cachedClassification is one stored row with freshness diagnostics.
type cachedClassification struct {
	Result       classificationResult
	Rule         RuleSignals
	Fresh        bool
	StaleReasons []StaleReason
}

// modelSelection is the current non-empty model configuration. Pointer fields
// follow the Nest `modelSelection?.embeddingModel != null` check: a missing
// model must not fabricate a model-stale reason.
type modelSelection struct {
	EmbeddingModel *string
	RerankModel    *string
}

// classificationStore reads the org-scoped cache rows.
type classificationStore struct {
	db *sql.DB
}

func (s *classificationStore) load(ctx context.Context, orgID string, articleIDs []string) ([]storedClassificationRow, error) {
	if len(articleIDs) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(articleIDs)), ",")
	args := make([]any, 0, len(articleIDs)+1)
	args = append(args, orgID)
	for _, id := range articleIDs {
		args = append(args, id)
	}
	query := `SELECT processedArticleId, articleId, region, vertical, ruleScores, embeddingScores, rerankScores, fusedScores,
       classificationTextHash, classificationTextVersion, taxonomyVersion, pipelineVersion, embeddingModel, rerankModel
FROM ArchiveArticleClassification
WHERE orgId = ? AND processedArticleId IN (` + placeholders + `)`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]storedClassificationRow, 0, len(articleIDs))
	for rows.Next() {
		var row storedClassificationRow
		var rule, embedding, rerank, fused []byte
		if err := rows.Scan(&row.ProcessedArticleID, &row.ArticleID, &row.Region, &row.Vertical,
			&rule, &embedding, &rerank, &fused, &row.ClassificationTextHash,
			&row.ClassificationTextVersion, &row.TaxonomyVersion, &row.PipelineVersion,
			&row.EmbeddingModel, &row.RerankModel); err != nil {
			return nil, err
		}
		row.RuleScores = rule
		row.EmbeddingScores = embedding
		row.RerankScores = rerank
		row.FusedScores = fused
		out = append(out, row)
	}
	return out, rows.Err()
}

// classificationLookup is one article's prepared text and rule context.
type classificationLookup struct {
	ProcessedArticleID string
	Text               string
	TextHash           string
	Rule               RuleSignals
}

// loadCached classifies cache rows into fresh and stale results. It never
// writes or regenerates: a text hash/version mismatch or an invalid stored
// region/vertical is a miss, and fresh filtering happens in the caller.
func (s *classificationStore) loadCached(ctx context.Context, orgID string, lookups []classificationLookup, models modelSelection) (map[string]cachedClassification, error) {
	if len(lookups) == 0 {
		return map[string]cachedClassification{}, nil
	}
	ids := make([]string, len(lookups))
	byID := make(map[string]classificationLookup, len(lookups))
	for index, lookup := range lookups {
		ids[index] = lookup.ProcessedArticleID
		byID[lookup.ProcessedArticleID] = lookup
	}
	rows, err := s.load(ctx, orgID, ids)
	if err != nil {
		return nil, err
	}
	results := make(map[string]cachedClassification, len(rows))
	for _, row := range rows {
		lookup, ok := byID[row.ProcessedArticleID]
		if !ok {
			continue
		}
		if row.ClassificationTextHash != lookup.TextHash || row.ClassificationTextVersion != classificationTextVersion {
			continue
		}
		region, ok := ParseRegion(row.Region)
		if !ok {
			continue
		}
		vertical, ok := ParseVertical(row.Vertical)
		if !ok {
			continue
		}
		ruleScores := parseScoreVector(row.RuleScores)
		embeddingScores := parseScoreVector(row.EmbeddingScores)
		rerankScores := parseScoreVector(row.RerankScores)
		fusedScores := parseScoreVector(row.FusedScores)
		selection := selectVerticalOutcome(fusedScores, ruleScores, embeddingScores, rerankScores, lookup.Rule)
		staleReasons := cachedStaleReasons(row, models)
		decision := selection.reason
		if len(staleReasons) > 0 && selection.vertical != vertical {
			decision = DecisionStaleCachedResult
		}
		results[row.ProcessedArticleID] = cachedClassification{
			Fresh:        len(staleReasons) == 0,
			StaleReasons: staleReasons,
			Rule:         lookup.Rule,
			Result: classificationResult{
				ProcessedArticleID: row.ProcessedArticleID,
				Region:             region,
				Vertical:           vertical,
				DecisionReason:     decision,
				RuleScores:         ruleScores,
				EmbeddingScores:    embeddingScores,
				RerankScores:       rerankScores,
				FusedScores:        fusedScores,
				CountryLabel:       lookup.Rule.CountryLabel,
				EntityTags:         lookup.Rule.EntityTags,
				TaxonomyVersion:    row.TaxonomyVersion,
				PipelineVersion:    row.PipelineVersion,
				EmbeddingModel:     row.EmbeddingModel,
				RerankModel:        row.RerankModel,
			},
		}
	}
	return results, nil
}

func cachedStaleReasons(row storedClassificationRow, models modelSelection) []StaleReason {
	reasons := make([]StaleReason, 0, 4)
	if row.TaxonomyVersion != classificationTaxonomyVersion {
		reasons = append(reasons, StaleTaxonomyVersion)
	}
	if row.PipelineVersion != classificationPipelineVersion {
		reasons = append(reasons, StalePipelineVersion)
	}
	if models.EmbeddingModel != nil && row.EmbeddingModel != *models.EmbeddingModel {
		reasons = append(reasons, StaleEmbeddingModel)
	}
	if models.RerankModel != nil && row.RerankModel != *models.RerankModel {
		reasons = append(reasons, StaleRerankModel)
	}
	return reasons
}

// selectionOutcome is the reproduced selectVerticalOutcome result.
type selectionOutcome struct {
	vertical Vertical
	reason   DecisionReason
}

// rankedWinner returns the highest score with the fixed vertical order as the
// 1e-9 tie-break.
func rankedWinner(scores scoreVector) Vertical {
	winner := VerticalOrder[0]
	best := scores[0]
	for _, vertical := range VerticalOrder[1:] {
		score := scores.get(vertical)
		if score > best+scoreTieEpsilon {
			best = score
			winner = vertical
		}
	}
	return winner
}

// selectVerticalOutcome reproduces the cached-result decision rules: strong
// country override (.62/.08), low semantic confidence fallback (.55), the
// low-fused foreign-affairs default (.5), then the fused winner.
func selectVerticalOutcome(fused, rule, embedding, rerank scoreVector, context RuleSignals) selectionOutcome {
	preliminary := rankedWinner(fused)
	ruleWinner := rankedWinner(rule)
	strongRule := Vertical("")
	for _, vertical := range context.CountryMatchedVerticals {
		if verticalIndex(vertical) >= 0 {
			strongRule = vertical
			break
		}
	}

	if strongRule != "" && preliminary != strongRule {
		winnerScore := fused.get(preliminary)
		strongScore := fused.get(strongRule)
		if winnerScore < strongRuleConflictMaxScore || winnerScore-strongScore < strongRuleConflictMaxGap {
			return selectionOutcome{vertical: strongRule, reason: DecisionStrongRuleOverride}
		}
	}
	if preliminary != strongRule &&
		embedding.get(preliminary) < semanticMinConfidence &&
		rerank.get(preliminary) < semanticMinConfidence {
		return selectionOutcome{vertical: ruleWinner, reason: DecisionLowSemanticConfidence}
	}
	if rule.get(ruleWinner) <= 0 &&
		embedding.get(preliminary) < semanticMinConfidence &&
		rerank.get(preliminary) < semanticMinConfidence &&
		fused.get(preliminary) < lowConfidenceFusedScore {
		return selectionOutcome{vertical: VerticalForeignAffairs, reason: DecisionDefaultForeignAffairs}
	}
	return selectionOutcome{vertical: preliminary, reason: DecisionFusedWinner}
}

func isFinite(value float64) bool {
	return !(value != value) && value <= 1e308 && value >= -1e308
}

func clamp01(value float64) float64 {
	if !isFinite(value) || value <= 0 {
		return 0
	}
	if value >= 1 {
		return 1
	}
	return value
}

func clamp01Rounded6(value float64) float64 {
	if !isFinite(value) || value <= 0 {
		return 0
	}
	if value >= 1 {
		return 1
	}
	return float64(int64(value*1e6+0.5)) / 1e6
}
