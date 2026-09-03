package httpapi

import "encoding/json"

// upsertRequest 镜像 TS VectorUpsertRequestSchema：
//
//	orgId/embeddingModel 非空字符串；points 数组（缺省为空），
//	每个 point：processedItemId/itemMetaId 非空、createdAtMs 非负整数、
//	vector 至少 1 个有限数。
//
// 数字字段用 json.Number 保留字面量，以精确复刻 zod 的 int/finite 校验
// （1.5 被拒、1e2 被接受等）。
type upsertRequest struct {
	OrgID          string        `json:"orgId"`
	EmbeddingModel string        `json:"embeddingModel"`
	Points         []upsertPoint `json:"points"`
}

type upsertPoint struct {
	ProcessedItemID string        `json:"processedItemId"`
	ItemMetaID      string        `json:"itemMetaId"`
	CreatedAtMs     json.Number   `json:"createdAtMs"`
	Vector          []json.Number `json:"vector"`
}

func (r *upsertRequest) validate() bool {
	if !nonEmptyString(r.OrgID) || !nonEmptyString(r.EmbeddingModel) {
		return false
	}
	// zod .default([])：points 缺失视为空数组（encoding/json 已按 nil 处理）。
	for _, p := range r.Points {
		if !nonEmptyString(p.ProcessedItemID) || !nonEmptyString(p.ItemMetaID) {
			return false
		}
		if !numIntInRange(p.CreatedAtMs, 0, int64Limit) {
			return false
		}
		if !numsFiniteNonEmpty(p.Vector) {
			return false
		}
	}
	return true
}

// searchRequest 镜像 TS VectorSearchRequestSchema：
//
//	orgId/embeddingModel 非空；vector 至少 1 个有限数；
//	limit 可选（正整数 ≤500）；minScore 可选（0..1）；lookbackMs 可选（正整数）。
type searchRequest struct {
	OrgID          string        `json:"orgId"`
	EmbeddingModel string        `json:"embeddingModel"`
	Vector         []json.Number `json:"vector"`
	Limit          *json.Number  `json:"limit"`
	MinScore       *json.Number  `json:"minScore"`
	LookbackMs     *json.Number  `json:"lookbackMs"`
}

func (r *searchRequest) validate() bool {
	if !nonEmptyString(r.OrgID) || !nonEmptyString(r.EmbeddingModel) {
		return false
	}
	if !numsFiniteNonEmpty(r.Vector) {
		return false
	}
	if r.Limit != nil && !numIntInRange(*r.Limit, 1, 500) {
		return false
	}
	if r.MinScore != nil {
		f, err := r.MinScore.Float64()
		if err != nil || f < 0 || f > 1 {
			return false
		}
	}
	if r.LookbackMs != nil && !numIntInRange(*r.LookbackMs, 1, int64Limit) {
		return false
	}
	return true
}

// mixedDimensions 镜像 TS VectorService.upsert 的维度一致性检查。
func (r *upsertRequest) mixedDimensions() bool {
	if len(r.Points) == 0 {
		return false
	}
	expected := len(r.Points[0].Vector)
	for _, p := range r.Points {
		if len(p.Vector) != expected {
			return true
		}
	}
	return false
}

// int64Limit 是安全上限，仅用于表达「非负/正整数」上界（JSON number 全域可用）。
const int64Limit = 1 << 53

func nonEmptyString(value string) bool {
	// zod z.string().min(1) 仅校验长度，不做 trim——空串被拒，纯空白串被接受（与 TS 一致）。
	return len(value) >= 1
}
