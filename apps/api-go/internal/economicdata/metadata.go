package economicdata

import (
	"bytes"
	"encoding/json"
)

// buildSeedMetadata renders the five legacy metadata keys ensureCatalog writes
// for one definition.
func buildSeedMetadata(definition Definition) ItemMetadata {
	config := definition.ProviderConfig
	meta := ItemMetadata{
		Method:        "GET",
		DefaultParams: nil,
		Tags:          append([]string(nil), definition.Tags...),
		Filter:        nil,
	}
	if definition.ProviderKind == ProviderAkshare {
		meta.Method = config.Method
		if meta.Method == "" {
			meta.Method = "GET"
		}
		params := config.DefaultParams
		if params != nil {
			copied := make(map[string]string, len(params))
			for key, value := range params {
				copied[key] = value
			}
			meta.DefaultParams = &copied
		}
		meta.Parser = config.Parser
		meta.Filter = config.Filter
	}
	return meta
}

// buildCustomMetadata renders the provider keys appended after the legacy
// metadata. The NestJS normalizeCustomMetadata always emits explicit nulls for
// optional fields.
func buildCustomMetadata(definition Definition) ItemMetadata {
	enabled := definition.DefaultEnabled
	config := definition.ProviderConfig
	role := definition.MainlineRole
	if role == "" {
		role = string(Canonical)
	}
	meta := ItemMetadata{
		ProviderKind:   definition.ProviderKind,
		ProviderConfig: &config,
		DefaultEnabled: &enabled,
		MainlineRole:   role,
		Snapshot:       definition.Snapshot,
		DataViz:        definition.DataViz,
	}
	if definition.RequiresSecret != "" {
		secret := definition.RequiresSecret
		meta.RequiresSecret = &secret
	}
	return meta
}

// normalizeMetadata reproduces normalizeMetadata in AkshareService: every
// legacy key has a concrete value.
func normalizeMetadata(meta ItemMetadata) ItemMetadata {
	if meta.Method == "" {
		meta.Method = "GET"
	}
	if meta.Tags == nil {
		meta.Tags = []string{}
	}
	return meta
}

// parseItemMetadata decodes a persisted metadata document. Invalid or non-object
// JSON becomes a zero document, matching parseMetadata.
func parseItemMetadata(raw []byte) ItemMetadata {
	var meta ItemMetadata
	if len(raw) == 0 {
		return meta
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&meta); err != nil {
		return ItemMetadata{}
	}
	return meta
}

// parseProviderKind mirrors parseProviderKind.
func parseProviderKind(raw ProviderKind) ProviderKind {
	switch raw {
	case ProviderAkshare, ProviderFinnhub, ProviderFred, ProviderYfinance:
		return raw
	default:
		return ProviderAkshare
	}
}

// parseMainlineRole mirrors parseMainlineRole.
func parseMainlineRole(raw string) string {
	switch MainlineRole(raw) {
	case Canonical, Derived, Internal, Fallback:
		return raw
	default:
		return string(Canonical)
	}
}

// parseRequiredSecret mirrors parseRequiredSecret.
func parseRequiredSecret(raw *string) string {
	if raw == nil {
		return ""
	}
	switch *raw {
	case "finnhubApiKey", "fredApiKey":
		return *raw
	default:
		return ""
	}
}

// mergeMetadata mirrors mergeMetadata: existing legacy values win, absent ones
// fall back to the seed.
func mergeMetadata(existing, seed ItemMetadata) ItemMetadata {
	if existing.Method == "" {
		existing.Method = seed.Method
	}
	if existing.Method == "" {
		existing.Method = "GET"
	}
	if existing.DefaultParams == nil {
		existing.DefaultParams = seed.DefaultParams
	}
	if existing.Parser == nil || existing.Parser.Type == "" {
		existing.Parser = seed.Parser
	}
	if existing.Tags == nil {
		existing.Tags = seed.Tags
	}
	if existing.Filter == nil {
		existing.Filter = seed.Filter
	}
	return existing
}

// mergeCustomMetadata overwrites the provider-owned keys with the definition,
// exactly like `{...existingCustom, ...normalizeCustomMetadata(seed)}`.
func mergeCustomMetadata(existing, seed ItemMetadata) ItemMetadata {
	existing.ProviderKind = seed.ProviderKind
	existing.ProviderConfig = seed.ProviderConfig
	existing.RequiresSecret = seed.RequiresSecret
	existing.DefaultEnabled = seed.DefaultEnabled
	existing.MainlineRole = seed.MainlineRole
	existing.Snapshot = seed.Snapshot
	existing.DataViz = seed.DataViz
	return existing
}

// metadataEqual compares the canonical JSON serialization. Both sides are
// already decoded into the same struct, so map and slice ordering is stable.
func metadataEqual(left, right ItemMetadata) bool {
	leftJSON, leftErr := json.Marshal(normalizeMetadata(left))
	rightJSON, rightErr := json.Marshal(normalizeMetadata(right))
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}
