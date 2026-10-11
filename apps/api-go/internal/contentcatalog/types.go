package contentcatalog

import "time"

type candidate struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
	Count           int
	LastSeenAt      time.Time
	Metadata        map[string]any
}

type resolution struct {
	Kind             string
	NormalizedValue  string
	DisplayValue     string
	TaxonomyPath     *string
	TaxonomyVersion  string
	EmbeddingModel   *string
	EmbeddingVector  []float64
	Metadata         map[string]any
	MetadataExplicit bool
	Count            int
	LastSeenAt       time.Time
}

type catalogRow struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
	Count           int
	LastSeenAt      time.Time
	TaxonomyPath    string
	HasTaxonomyPath bool
	TaxonomyVersion string
	EmbeddingModel  string
	EmbeddingVector []byte
	Metadata        []byte
}

type scoredRow struct {
	Row      catalogRow
	Score    float64
	HasScore bool
}

type inputEntry struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
	Source          string
}

func subscriptionKey(kind, normalized string) string {
	return kind + ":" + normalized
}

func chunk[T any](values []T, size int) [][]T {
	if size < 1 {
		size = 1
	}
	out := make([][]T, 0, (len(values)+size-1)/size)
	for start := 0; start < len(values); start += size {
		end := start + size
		if end > len(values) {
			end = len(values)
		}
		out = append(out, values[start:end])
	}
	return out
}
