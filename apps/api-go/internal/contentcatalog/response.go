package contentcatalog

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

type catalogItem struct {
	Kind                string          `json:"kind"`
	NormalizedValue     string          `json:"normalizedValue"`
	DisplayValue        string          `json:"displayValue"`
	Count               int             `json:"count"`
	LastSeenAt          string          `json:"lastSeenAt"`
	TaxonomyPath        *string         `json:"taxonomyPath"`
	TaxonomyDisplayName *string         `json:"taxonomyDisplayName"`
	TaxonomyLabels      []string        `json:"taxonomyLabels"`
	Metadata            json.RawMessage `json:"metadata,omitempty"`
	Score               *float64        `json:"score,omitempty"`
}

type catalogPayload struct {
	Limit           int           `json:"limit"`
	TaxonomyVersion string        `json:"taxonomyVersion"`
	Items           []catalogItem `json:"items"`
}

func marshalCatalog(limit int, version string, items []catalogItem) ([]byte, error) {
	if items == nil {
		items = []catalogItem{}
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(catalogPayload{Limit: limit, TaxonomyVersion: version, Items: items}); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func mapCatalogRow(row catalogRow, byPath map[string]taxNode, score *float64) catalogItem {
	path := nullablePath(row)
	display, labels := taxonomyInfo(deref(path), byPath)
	meta, ok := parseMetadata(row.Metadata)
	raw := json.RawMessage("null")
	if ok {
		encoded, err := json.Marshal(meta)
		if err == nil {
			raw = encoded
		}
	}
	return catalogItem{
		Kind:                row.Kind,
		NormalizedValue:     row.NormalizedValue,
		DisplayValue:        row.DisplayValue,
		Count:               row.Count,
		LastSeenAt:          isoTime(row.LastSeenAt),
		TaxonomyPath:        path,
		TaxonomyDisplayName: display,
		TaxonomyLabels:      labels,
		Metadata:            raw,
		Score:               score,
	}
}

func mapResolutionItem(row resolution, byPath map[string]taxNode, at time.Time) catalogItem {
	display, labels := taxonomyInfo(deref(row.TaxonomyPath), byPath)
	item := catalogItem{
		Kind:                row.Kind,
		NormalizedValue:     row.NormalizedValue,
		DisplayValue:        row.DisplayValue,
		Count:               0,
		LastSeenAt:          isoTime(at),
		TaxonomyPath:        row.TaxonomyPath,
		TaxonomyDisplayName: display,
		TaxonomyLabels:      labels,
	}
	if row.MetadataExplicit {
		if row.Metadata == nil {
			item.Metadata = json.RawMessage("null")
		} else if encoded, err := json.Marshal(row.Metadata); err == nil {
			item.Metadata = encoded
		}
	}
	return item
}

func nullablePath(row catalogRow) *string {
	if !row.HasTaxonomyPath || row.TaxonomyPath == "" {
		return nil
	}
	path := row.TaxonomyPath
	return &path
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func toContract(row resolution) personalnews.CatalogResolution {
	var version *string
	if row.TaxonomyVersion != "" {
		copied := row.TaxonomyVersion
		version = &copied
	}
	last := ""
	if !row.LastSeenAt.IsZero() {
		last = isoTime(row.LastSeenAt)
	}
	return personalnews.CatalogResolution{
		Kind:            row.Kind,
		NormalizedValue: row.NormalizedValue,
		DisplayValue:    row.DisplayValue,
		TaxonomyPath:    row.TaxonomyPath,
		TaxonomyVersion: version,
		EmbeddingModel:  row.EmbeddingModel,
		EmbeddingVector: row.EmbeddingVector,
		Metadata:        row.Metadata,
		Count:           row.Count,
		LastSeenAt:      last,
	}
}
