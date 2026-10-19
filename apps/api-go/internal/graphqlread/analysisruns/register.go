// Package analysisrunsgraphql serves the three analysis run Mutations migrated
// by ANALYSIS-RUNS-001: requestCorrelationAnalysis, requestAnomalyExplanation
// and requestGeoTransportAnalysis. Each resolver re-derives the organization and
// user from the authenticated identity, validates the input with the reachable
// DTO constraints, inserts the pending analysisresults document and enqueues the
// BullMQ job. It never waits for the model and never computes the analysis in
// the request path.
package analysisrunsgraphql

import (
	"context"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/analysisruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// RegisteredMutations lists the mutation names Register adds.
var RegisteredMutations = []string{
	"requestCorrelationAnalysis",
	"requestAnomalyExplanation",
	"requestGeoTransportAnalysis",
}

type service struct {
	submitter *analysisruns.Submitter
}

// Register adds the three mutations and only the AnalysisResultModel object
// type. The history Query roots, assistant model and notification model remain
// unregistered; any document selecting them falls back to NestJS as a whole.
func Register(reg *contract.Registry, submitter *analysisruns.Submitter) {
	if reg == nil {
		panic("graphqlread: analysisruns.Register requires a registry")
	}
	history.RegisterAnalysisModel(reg)
	svc := &service{submitter: submitter}
	reg.RegisterMutation(contract.Root{
		Name:       "requestCorrelationAnalysis",
		Permission: "analysis.run",
		Resolve:    contract.Bind(svc.requestCorrelationAnalysis),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "requestAnomalyExplanation",
		Permission: "analysis.run",
		Resolve:    contract.Bind(svc.requestAnomalyExplanation),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "requestGeoTransportAnalysis",
		Permission: "analysis.run",
		Resolve:    contract.Bind(svc.requestGeoTransportAnalysis),
	})
}

func (s *service) requestCorrelationAnalysis(ctx contract.Context) (history.AnalysisResultModel, error) {
	input, err := parseCorrelationInput(ctx.Args)
	if err != nil {
		return history.AnalysisResultModel{}, graphqlFailure(err)
	}
	record, err := s.submitter.SubmitCorrelation(
		callContext(ctx),
		ctx.Identity.OrgID,
		input,
		triggeredBy(ctx),
		traceID(ctx),
	)
	if err != nil {
		return history.AnalysisResultModel{}, err
	}
	return pendingModel(record, analysisruns.TypeCorrelation, input)
}

func (s *service) requestAnomalyExplanation(ctx contract.Context) (history.AnalysisResultModel, error) {
	input, err := parseAnomalyInput(ctx.Args)
	if err != nil {
		return history.AnalysisResultModel{}, graphqlFailure(err)
	}
	record, err := s.submitter.SubmitAnomaly(
		callContext(ctx),
		ctx.Identity.OrgID,
		input,
		triggeredBy(ctx),
		traceID(ctx),
	)
	if err != nil {
		return history.AnalysisResultModel{}, err
	}
	return pendingModel(record, analysisruns.TypeAnomaly, input)
}

func (s *service) requestGeoTransportAnalysis(ctx contract.Context) (history.AnalysisResultModel, error) {
	input, err := parseGeoTransportInput(ctx.Args)
	if err != nil {
		return history.AnalysisResultModel{}, graphqlFailure(err)
	}
	record, err := s.submitter.SubmitGeoTransport(
		callContext(ctx),
		ctx.Identity.OrgID,
		input,
		triggeredBy(ctx),
		traceID(ctx),
	)
	if err != nil {
		return history.AnalysisResultModel{}, err
	}
	return pendingModel(record, analysisruns.TypeGeoTransport, input)
}

// pendingModel is the success projection: id, type, pending, createdAt and the
// saved input. summary, error and output stay undefined/null exactly like the
// NestJS resolver.
func pendingModel[T any](record analysisruns.PendingRecord, analysisType analysisruns.Type, input T) (history.AnalysisResultModel, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return history.AnalysisResultModel{}, err
	}
	return history.AnalysisResultModel{
		ID:        record.ID,
		Type:      string(analysisType),
		Status:    string(analysisruns.StatusPending),
		CreatedAt: record.CreatedAt,
		Input:     json.RawMessage(encoded),
	}, nil
}

func triggeredBy(ctx contract.Context) *string {
	if ctx.Identity.UserID == "" {
		return nil
	}
	userID := ctx.Identity.UserID
	return &userID
}

func traceID(ctx contract.Context) string {
	incoming := ""
	if ctx.Ctx != nil {
		incoming = httpx.TraceIDFromContext(ctx.Ctx)
	}
	return httpx.EnsureTraceID(incoming)
}

func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}
