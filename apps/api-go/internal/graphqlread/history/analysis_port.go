package history

import "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"

// RegisterAnalysisModel registers only the AnalysisResultModel object type. It
// exists for the analysis run mutations: they return that model while the
// history Query roots, the assistant model and the notification model stay
// unregistered.
//
// The object type may already be registered by Register (full history reads) or
// RegisterModels (workspace writes). RegisterType is idempotent in this package,
// but the explicit check keeps the ownership rule visible: exactly one caller
// adds the model per registry.
func RegisterAnalysisModel(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: history.RegisterAnalysisModel requires a registry")
	}
	if reg.HasType("AnalysisResultModel") {
		return
	}
	reg.RegisterType("AnalysisResultModel", AnalysisResultModel{})
}
