package archivepreparationworker

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// settingsView is the four-field effective archive-preparation setting set.
type settingsView = dataruntimesettings.ArchivePreparationEffectiveSettings

// ModelClient is the model surface the selection and hybrid classification
// paths use.
type ModelClient interface {
	RuntimeEmbeddingModel(ctx context.Context) (litellmcompat.RuntimeModel, error)
	RuntimeRerankModel(ctx context.Context) (litellmcompat.RuntimeModel, error)
	Completion(ctx context.Context, req litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error)
	Embedding(ctx context.Context, req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error)
	Rerank(ctx context.Context, req litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error)
}
