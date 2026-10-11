package contentcatalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

const (
	maxTaxonomyNodes      = 512
	maxTaxonomyPathLength = 160
	maxTaxonomyTextLength = 500
	maxListSize           = 50
	maxListItemLength     = 80
)

var legacyCategories = map[string]struct{}{
	"politics": {}, "tech": {}, "finance": {}, "gov": {}, "ai": {}, "intel": {},
}

type taxNode struct {
	Path           string   `json:"path"`
	DisplayName    string   `json:"displayName"`
	Description    string   `json:"description"`
	LegacyCategory string   `json:"legacyCategory"`
	Keywords       []string `json:"keywords"`
	Synonyms       []string `json:"synonyms"`
}

type taxonomyDescriptor struct {
	Version   string
	Nodes     []taxNode
	ByPath    map[string]taxNode
	Documents []struct {
		Path string
		Text string
	}
}

type taxonomyEmbedding struct {
	Path   string
	Vector []float64
}

func (s *Service) loadTaxonomy(ctx context.Context, orgID string) taxonomyDescriptor {
	settings := s.readTaxonomySettings(ctx, orgID)
	nodes := settings.Taxonomy
	if nodes == nil {
		nodes = []taxNode{}
	}
	byPath := make(map[string]taxNode, len(nodes))
	documents := make([]struct {
		Path string
		Text string
	}, 0, len(nodes))
	for _, node := range nodes {
		byPath[node.Path] = node
		documents = append(documents, struct {
			Path string
			Text string
		}{Path: node.Path, Text: taxonomyDocument(node)})
	}
	return taxonomyDescriptor{
		Version:   settings.Version,
		Nodes:     nodes,
		ByPath:    byPath,
		Documents: documents,
	}
}

func (s *Service) readTaxonomySettings(ctx context.Context, orgID string) taxonomySettings {
	fallback := taxonomySettings{Version: defaultTaxonomyVersion, Taxonomy: defaultTaxonomy()}
	cacheKey := taxonomyCachePrefix + orgID
	if s.rdb != nil {
		raw, err := s.rdb.Get(ctx, cacheKey).Bytes()
		if err == nil && len(raw) > 0 {
			return normalizeTaxonomySettings(raw, fallback)
		}
		if err != nil && !errors.Is(err, redis.Nil) {
			log.Printf("contentcatalog: taxonomy cache read failed org=%s", orgID)
		}
	}
	settings := fallback
	if s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", taxonomySettingPrefix+orgID).Scan(&raw)
		switch {
		case err == nil:
			settings = normalizeTaxonomySettings(raw, fallback)
		case errors.Is(err, sql.ErrNoRows):
			settings = fallback
		default:
			log.Printf("contentcatalog: taxonomy settings read failed org=%s", orgID)
			settings = fallback
		}
	}
	if s.rdb != nil {
		payload, err := json.Marshal(settings.cacheDocument())
		if err == nil {
			if err := s.rdb.Set(ctx, cacheKey, payload, taxonomyCacheTTL).Err(); err != nil && ctx.Err() == nil {
				log.Printf("contentcatalog: taxonomy cache write failed org=%s", orgID)
			}
		}
	}
	return settings
}

type taxonomySettings struct {
	Enabled         bool      `json:"enabled"`
	StrictFail      bool      `json:"strictFail"`
	EnableLlm       bool      `json:"enableLlm"`
	EnableEmbedding bool      `json:"enableEmbedding"`
	EnableRerank    bool      `json:"enableRerank"`
	LLMModel        *string   `json:"llmModel"`
	MinConfidence   float64   `json:"minConfidence"`
	EmbeddingTopK   int       `json:"embeddingTopK"`
	RerankTopN      int       `json:"rerankTopN"`
	CacheTTLSeconds int       `json:"cacheTtlSeconds"`
	Version         string    `json:"taxonomyVersion"`
	Taxonomy        []taxNode `json:"taxonomy"`
}

func (settings taxonomySettings) cacheDocument() taxonomySettings {
	if settings.Taxonomy == nil {
		settings.Taxonomy = []taxNode{}
	}
	for i := range settings.Taxonomy {
		if settings.Taxonomy[i].Keywords == nil {
			settings.Taxonomy[i].Keywords = []string{}
		}
		if settings.Taxonomy[i].Synonyms == nil {
			settings.Taxonomy[i].Synonyms = []string{}
		}
	}
	return settings
}

func normalizeTaxonomySettings(raw []byte, fallback taxonomySettings) taxonomySettings {
	var doc map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &doc) != nil || doc == nil {
		return fallback
	}
	version := cleanString(doc["taxonomyVersion"], 64)
	if version == "" {
		version = fallback.Version
	}
	nodes := normalizeTaxonomyNodes(doc["taxonomy"], fallback.Taxonomy)
	return taxonomySettings{
		Enabled:         asBool(doc["enabled"], true),
		StrictFail:      asBool(doc["strictFail"], true),
		EnableLlm:       asBool(doc["enableLlm"], true),
		EnableEmbedding: asBool(doc["enableEmbedding"], true),
		EnableRerank:    asBool(doc["enableRerank"], true),
		LLMModel:        cleanNullableString(doc["llmModel"], 120),
		MinConfidence:   clampFloat(doc["minConfidence"], 0, 1, 0.35),
		EmbeddingTopK:   clampInt(doc["embeddingTopK"], 1, 100, 12),
		RerankTopN:      clampInt(doc["rerankTopN"], 1, 30, 6),
		CacheTTLSeconds: clampInt(doc["cacheTtlSeconds"], 0, 3600, 60),
		Version:         version,
		Taxonomy:        nodes,
	}
}

func normalizeTaxonomyNodes(value any, fallback []taxNode) []taxNode {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return append([]taxNode(nil), fallback...)
	}
	dedup := map[string]taxNode{}
	order := make([]string, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		path := normalizeTaxonomyPath(record["path"])
		if path == "" {
			continue
		}
		legacy := strings.TrimSpace(strings.ToLower(stringOrEmpty(record["legacyCategory"])))
		if _, known := legacyCategories[legacy]; !known {
			continue
		}
		display := cleanString(record["displayName"], maxTaxonomyTextLength)
		if display == "" {
			display = path
		}
		node := taxNode{
			Path:           path,
			DisplayName:    display,
			Description:    stringOrEmpty(cleanString(record["description"], maxTaxonomyTextLength)),
			LegacyCategory: legacy,
			Keywords:       normalizeStringList(record["keywords"]),
			Synonyms:       normalizeStringList(record["synonyms"]),
		}
		if _, exists := dedup[path]; !exists {
			order = append(order, path)
		}
		dedup[path] = node
		if len(dedup) >= maxTaxonomyNodes {
			break
		}
	}
	if len(dedup) == 0 {
		return append([]taxNode(nil), fallback...)
	}
	nodes := make([]taxNode, 0, len(order))
	for _, path := range order {
		nodes = append(nodes, dedup[path])
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Path < nodes[j].Path })
	return nodes
}

func normalizeTaxonomyPath(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	text = strings.TrimSpace(strings.ToLower(text))
	text = strings.ReplaceAll(text, `\`, "/")
	text = spaceRE.ReplaceAllString(text, "-")
	for strings.Contains(text, "//") {
		text = strings.ReplaceAll(text, "//", "/")
	}
	text = strings.Trim(text, "/")
	if text == "" || len(text) > maxTaxonomyPathLength {
		return ""
	}
	return text
}

func normalizeStringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		cleaned := cleanString(item, maxListItemLength)
		if cleaned == "" {
			continue
		}
		if _, exists := seen[cleaned]; exists {
			continue
		}
		seen[cleaned] = struct{}{}
		out = append(out, cleaned)
		if len(out) >= maxListSize {
			break
		}
	}
	return out
}

func cleanString(value any, maxLength int) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if len(text) > maxLength {
		return text[:maxLength]
	}
	return text
}

func cleanNullableString(value any, maxLength int) *string {
	if value == nil {
		return nil
	}
	cleaned := cleanString(value, maxLength)
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

func stringOrEmpty(value any) string {
	text, _ := value.(string)
	return text
}

func asBool(value any, fallback bool) bool {
	typed, ok := value.(bool)
	if !ok {
		return fallback
	}
	return typed
}

func clampInt(value any, min, max, fallback int) int {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	rounded := int(math.Round(number))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

func clampFloat(value any, min, max, fallback float64) float64 {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	if number < min {
		return min
	}
	if number > max {
		return max
	}
	return number
}

func taxonomyDocument(node taxNode) string {
	parts := []string{
		"path=" + node.Path,
		"legacy=" + node.LegacyCategory,
		"name=" + node.DisplayName,
		"description=" + node.Description,
	}
	if len(node.Keywords) > 0 {
		parts = append(parts, "keywords="+strings.Join(node.Keywords, ", "))
	}
	if len(node.Synonyms) > 0 {
		parts = append(parts, "synonyms="+strings.Join(node.Synonyms, ", "))
	}
	return strings.Join(parts, "\n")
}

func (s *Service) classifyCandidates(ctx context.Context, orgID string, candidates []candidate, taxonomy taxonomyDescriptor) ([]resolution, error) {
	var taxonomyVectors []taxonomyEmbedding
	var embeddingModel string
	needsTaxonomy := len(taxonomy.Documents) > 0 && candidatesNeedTaxonomy(candidates)
	if needsTaxonomy && s.models != nil {
		texts := make([]string, len(taxonomy.Documents))
		for i, doc := range taxonomy.Documents {
			texts[i] = doc.Text
		}
		vectors, model, err := s.models.Embed(llmembed.ContextWithMeta(ctx, "content-subscriptions", "taxonomy-catalog"), orgID, texts)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil {
			log.Printf("contentcatalog: taxonomy embedding failed org=%s", orgID)
		} else {
			embeddingModel = model
			taxonomyVectors = taxonomyVectorsFrom(taxonomy, vectors)
		}
	}
	results := make([]resolution, 0, len(candidates))
	for _, batch := range chunk(candidates, embeddingBatchSize) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		resolved, err := s.classifyBatch(ctx, orgID, batch, taxonomy, taxonomyVectors, embeddingModel)
		if err != nil {
			return nil, err
		}
		results = append(results, resolved...)
	}
	return results, nil
}

func candidatesNeedTaxonomy(candidates []candidate) bool {
	for _, candidate := range candidates {
		if candidate.Kind == personalnews.KindTopic || candidate.Kind == personalnews.KindEntity {
			return true
		}
	}
	return false
}

func taxonomyVectorsFrom(taxonomy taxonomyDescriptor, vectors [][]float64) []taxonomyEmbedding {
	out := make([]taxonomyEmbedding, 0, len(taxonomy.Documents))
	for i, doc := range taxonomy.Documents {
		if i >= len(vectors) || len(vectors[i]) == 0 {
			continue
		}
		normalized := normalizeVector(vectors[i])
		if len(normalized) == 0 {
			continue
		}
		out = append(out, taxonomyEmbedding{Path: doc.Path, Vector: normalized})
	}
	return out
}

func (s *Service) classifyBatch(ctx context.Context, orgID string, batch []candidate, taxonomy taxonomyDescriptor, taxonomyVectors []taxonomyEmbedding, embeddingModel string) ([]resolution, error) {
	texts := make([]string, len(batch))
	for i, candidate := range batch {
		texts[i] = catalogEmbeddingText(candidate)
	}
	var vectors [][]float64
	model := embeddingModel
	if s.models != nil {
		callCtx := llmembed.ContextWithMeta(ctx, "content-subscriptions", "catalog-item")
		if model != "" {
			callCtx = llmembed.ContextWithModel(callCtx, model)
		}
		embedded, responseModel, err := s.models.Embed(callCtx, orgID, texts)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil {
			log.Printf("contentcatalog: catalog embedding failed org=%s", orgID)
		} else {
			vectors = embedded
			if responseModel != "" {
				model = responseModel
			}
		}
	}
	results := make([]resolution, 0, len(batch))
	for index, candidate := range batch {
		var vector []float64
		if index < len(vectors) {
			vector = normalizeVector(vectors[index])
		}
		path := catalogTaxonomyPath(candidate, vector, taxonomy, taxonomyVectors)
		var modelPtr *string
		if model != "" && len(vector) > 0 {
			copied := model
			modelPtr = &copied
		} else if model != "" && s.models != nil && len(vectors) > 0 {
			copied := model
			modelPtr = &copied
		}
		var stored []float64
		if len(vector) > 0 {
			stored = vector
		}
		results = append(results, resolution{
			Kind:             candidate.Kind,
			NormalizedValue:  candidate.NormalizedValue,
			DisplayValue:     candidate.DisplayValue,
			TaxonomyPath:     path,
			TaxonomyVersion:  taxonomy.Version,
			EmbeddingModel:   modelPtr,
			EmbeddingVector:  stored,
			Metadata:         candidate.Metadata,
			MetadataExplicit: candidate.Metadata != nil,
			Count:            candidate.Count,
			LastSeenAt:       candidate.LastSeenAt,
		})
	}
	if len(vectors) == 0 {
		results = results[:0]
		for _, candidate := range batch {
			results = append(results, adHocResolution(candidate, taxonomy.Version, catalogTaxonomyPath(candidate, nil, taxonomy, nil)))
		}
	}
	return results, nil
}

func adHocResolution(candidate candidate, version string, path *string) resolution {
	return resolution{
		Kind:             candidate.Kind,
		NormalizedValue:  candidate.NormalizedValue,
		DisplayValue:     candidate.DisplayValue,
		TaxonomyPath:     path,
		TaxonomyVersion:  version,
		Metadata:         candidate.Metadata,
		MetadataExplicit: candidate.Metadata != nil,
		Count:            candidate.Count,
		LastSeenAt:       candidate.LastSeenAt,
	}
}

func catalogEmbeddingText(candidate candidate) string {
	parts := []string{
		"kind=" + candidate.Kind,
		"name=" + candidate.DisplayValue,
	}
	if candidate.Kind == personalnews.KindEntity && candidate.Metadata != nil && candidate.Metadata["entityType"] != nil {
		parts = append(parts, "entityType="+stringify(candidate.Metadata["entityType"]))
	}
	if candidate.Kind == personalnews.KindSource {
		if value := metaString(candidate.Metadata, "sourceId"); value != "" {
			parts = append(parts, "sourceId="+value)
		}
	}
	if candidate.Kind == personalnews.KindGeo {
		if value := metaString(candidate.Metadata, "countryCodeAlpha2"); value != "" {
			parts = append(parts, "country="+value)
		}
	}
	return strings.Join(parts, "\n")
}

func catalogTaxonomyPath(candidate candidate, vector []float64, taxonomy taxonomyDescriptor, embeddings []taxonomyEmbedding) *string {
	if candidate.Kind != personalnews.KindTopic && candidate.Kind != personalnews.KindEntity {
		return nil
	}
	if len(vector) > 0 && len(embeddings) > 0 {
		return pickBestTaxonomyPath(vector, embeddings)
	}
	return classifyByKeyword(candidate.DisplayValue, taxonomy.Nodes)
}

func pickBestTaxonomyPath(vector []float64, embeddings []taxonomyEmbedding) *string {
	bestScore := math.Inf(-1)
	var best string
	found := false
	for _, candidate := range embeddings {
		if len(candidate.Vector) != len(vector) {
			continue
		}
		score := dot(vector, candidate.Vector)
		if score > bestScore {
			bestScore = score
			best = candidate.Path
			found = true
		}
	}
	if !found {
		return nil
	}
	return &best
}

func classifyByKeyword(value string, nodes []taxNode) *string {
	text := strings.ToLower(strings.TrimSpace(value))
	if text == "" {
		return nil
	}
	bestScore := 0
	var best string
	for _, node := range nodes {
		signals := make([]string, 0, 2+len(node.Keywords)+len(node.Synonyms))
		signals = append(signals, node.DisplayName, node.Description)
		signals = append(signals, node.Keywords...)
		signals = append(signals, node.Synonyms...)
		score := 0
		for _, signal := range signals {
			normalized := strings.ToLower(strings.TrimSpace(signal))
			if normalized == "" {
				continue
			}
			if strings.Contains(text, normalized) || strings.Contains(normalized, text) {
				if normalized == text {
					score += 4
				} else {
					score++
				}
			}
		}
		if score > bestScore {
			bestScore = score
			best = node.Path
		}
	}
	if bestScore == 0 {
		return nil
	}
	return &best
}

func metaString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	value, _ := metadata[key].(string)
	return value
}

func stringify(value any) string {
	if value == nil {
		return ""
	}
	text, ok := value.(string)
	if ok {
		return text
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return strings.Trim(string(raw), `"`)
}

func taxonomyInfo(path string, byPath map[string]taxNode) (display *string, labels []string) {
	labels = []string{}
	if path == "" {
		return nil, labels
	}
	name := path
	if node, ok := byPath[path]; ok && node.DisplayName != "" {
		name = node.DisplayName
	}
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			labels = append(labels, part)
		}
	}
	return &name, labels
}

func taxonomyBranchPrefix(path string) string {
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if len(parts) >= 2 {
		return parts[0] + "/" + parts[1]
	}
	return path
}

func sinceWindow(now time.Time) time.Time {
	return now.Add(-catalogWindowDays * day)
}
