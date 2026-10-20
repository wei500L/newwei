package newseventsingest

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// ClusteringMode is the NewsEventSettings.clusteringMode value.
type ClusteringMode string

const (
	// ClusteringModeVector is the default per-article assignment mode.
	ClusteringModeVector ClusteringMode = "vector"
	// ClusteringModeBertopicPrimary groups the batch through the model service
	// before assigning.
	ClusteringModeBertopicPrimary ClusteringMode = "bertopic_primary"
)

// Settings is the ingestion subset of NewsEventSettings after normalization.
// Every clamp and default already happened in the shared read model, so this is
// a plain projection.
type Settings struct {
	Enabled                      bool
	IngestionEnabled             bool
	ClusteringMode               ClusteringMode
	BertopicMinItemsPerGroup     int
	BertopicMaxItemsPerRequest   int
	BertopicMinTopicSize         int
	MaxBatchSize                 int
	BackfillDays                 int
	LookbackDays                 int
	VectorMinScore               float64
	CrossLanguagePenalty         float64
	ClassificationGateEnabled    bool
	CategoryConflictReject       bool
	CategorySoftPenalty          float64
	MinCategoryConfidenceForGate float64
}

// SettingsReader reads the normalized news-event settings of one organization.
type SettingsReader interface {
	ReadNewsEventSettings(ctx context.Context, orgID string) (Settings, error)
}

// SettingsFromReadModel projects the shared news-event settings read model onto
// the ingestion subset.
func SettingsFromReadModel(model settingscrawl.NewsEventSettingsModel) Settings {
	clusteringMode := ClusteringModeVector
	if model.ClusteringMode == settingscrawl.NewsEventClusteringModeBertopicPrimary {
		clusteringMode = ClusteringModeBertopicPrimary
	}
	return Settings{
		Enabled:                      model.Enabled,
		IngestionEnabled:             model.IngestionEnabled,
		ClusteringMode:               clusteringMode,
		BertopicMinItemsPerGroup:     model.BertopicMinItemsPerGroup,
		BertopicMaxItemsPerRequest:   model.BertopicMaxItemsPerRequest,
		BertopicMinTopicSize:         model.BertopicMinTopicSize,
		MaxBatchSize:                 model.MaxBatchSize,
		BackfillDays:                 model.BackfillDays,
		LookbackDays:                 model.LookbackDays,
		VectorMinScore:               model.VectorMinScore,
		CrossLanguagePenalty:         model.CrossLanguagePenalty,
		ClassificationGateEnabled:    model.ClassificationGateEnabled,
		CategoryConflictReject:       model.CategoryConflictReject,
		CategorySoftPenalty:          model.CategorySoftPenalty,
		MinCategoryConfidenceForGate: model.MinCategoryConfidenceForGate,
	}
}

// ReadModelSettingsReader adapts the shared settingscrawl reader to
// SettingsReader.
type ReadModelSettingsReader struct {
	Reader *settingscrawl.NewsEventsIngestSettingsReader
}

// ReadNewsEventSettings implements SettingsReader.
func (r ReadModelSettingsReader) ReadNewsEventSettings(ctx context.Context, orgID string) (Settings, error) {
	if r.Reader == nil {
		return SettingsFromReadModel(settingscrawl.NewsEventSettingsModel{}), nil
	}
	model, err := r.Reader.ReadIngestSettings(ctx, orgID)
	if err != nil {
		return Settings{}, err
	}
	return SettingsFromReadModel(model), nil
}
