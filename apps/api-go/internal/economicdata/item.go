package economicdata

import (
	"fmt"
	"strings"
)

// itemConfigFromRow reproduces loadDefinitionFromDatabase plus
// parseDefinitionMetadataFromRecord.
func itemConfigFromRow(item ItemRow) (ItemConfig, error) {
	meta := parseItemMetadata(item.Metadata)
	providerKind := parseProviderKind(meta.ProviderKind)
	config, err := providerConfigFromMetadata(item, meta, providerKind)
	if err != nil {
		return ItemConfig{}, err
	}
	requiresSecret := parseRequiredSecret(meta.RequiresSecret)
	defaultEnabled := true
	if meta.DefaultEnabled != nil {
		defaultEnabled = *meta.DefaultEnabled
	}
	role := parseMainlineRole(meta.MainlineRole)
	tags := meta.Tags
	if tags == nil {
		tags = []string{}
	}
	return ItemConfig{
		ItemID:           item.ID,
		Slug:             item.Slug,
		DisplayName:      item.DisplayName,
		Description:      item.Description,
		SourceFunction:   item.SourceFunction,
		Endpoint:         item.SourceEndpoint,
		DocURL:           item.SourceDocURL,
		ValueType:        item.ValueType,
		DefaultUnit:      item.DefaultUnit,
		DefaultFrequency: item.DefaultFrequency,
		ProviderKind:     providerKind,
		ProviderConfig:   *config,
		RequiresSecret:   requiresSecret,
		DefaultEnabled:   defaultEnabled,
		MainlineRole:     role,
		Snapshot:         meta.Snapshot,
		DataViz:          meta.DataViz,
		Tags:             tags,
	}, nil
}

func providerConfigFromMetadata(item ItemRow, meta ItemMetadata, kind ProviderKind) (*ProviderConfig, error) {
	if meta.ProviderConfig != nil && meta.ProviderConfig.Kind == kind {
		copied := *meta.ProviderConfig
		return &copied, nil
	}
	if kind != ProviderAkshare {
		return nil, fmt.Errorf("Provider config missing for %s", item.Slug)
	}
	if meta.Parser == nil || meta.Parser.Type == "" {
		return nil, fmt.Errorf("Akshare parser not configured for %s", item.Slug)
	}
	docURL := ""
	if item.SourceDocURL != nil {
		docURL = *item.SourceDocURL
	}
	config := ProviderConfig{
		Kind:         ProviderAkshare,
		FunctionName: item.SourceFunction,
		Endpoint:     item.SourceEndpoint,
		DocURL:       docURL,
		Method:       meta.Method,
		Parser:       meta.Parser,
	}
	if config.Method == "" {
		config.Method = "GET"
	}
	if meta.DefaultParams != nil {
		config.DefaultParams = *meta.DefaultParams
	}
	if meta.Filter != nil {
		config.Filter = meta.Filter
	}
	return &config, nil
}

func (c ItemConfig) unitOr(fallback string) string {
	if c.DefaultUnit == nil || strings.TrimSpace(*c.DefaultUnit) == "" {
		return fallback
	}
	return *c.DefaultUnit
}

func (c ItemConfig) docURLString() string {
	if c.DocURL == nil {
		return ""
	}
	return *c.DocURL
}
