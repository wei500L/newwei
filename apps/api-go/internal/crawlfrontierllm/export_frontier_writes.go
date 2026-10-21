package crawlfrontierllm

import (
	"context"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// export_frontier_writes.go exports the Frontier run creation chain
// (createRunFromProfile) so the crawl-frontier admin write routes in
// internal/crawlfrontierruns can reuse it instead of duplicating it. It adds no
// new behaviour: the entry point and the option type are aliases over the
// existing private ones, so the shadow-learning path that already calls them
// keeps its exact semantics.
//
// NestJS has two layers here (crawl-frontier.service.ts): createRun resolves the
// effective profile, merges keywords, clamps the budgets and passes a
// runMetadata patch, then createRunFromProfile writes the synthetic CrawlTask,
// the CrawlFrontierRun, the workflow run and the root node and enqueues the root
// node. Only the second layer lives in this package, because the first one is
// HTTP-service logic; the caller owns it and passes the resolved values in.
//
// Error contract: the HTTP write routes render errors with the NestJS
// GlobalExceptionFilter shape, so the two entry points below normalise the
// crawlworkflow package's HTTP-shaped errors (404 "Workflow version not found",
// 400 "Workflow has no published version") into NestError. The shared judge/node
// entry points keep returning the original error values.

// CreateRunOptions is createRunFromProfile's argument set.
type CreateRunOptions = createRunOptions

// CreateFrontierRunProfile is createRun's effective-profile resolution. Unlike
// ResolveEffectiveProfileForURL it converts the bound-workflow errors into
// NestError, because the write route has to answer with the same 404/400
// NestJS throws from resolveBoundWorkflowVersion.
func (s *Service) CreateFrontierRunProfile(ctx context.Context, orgID string, profileID *string, seedURL string) (*ProfileRecord, error) {
	profile, err := s.resolveEffectiveProfile(ctx, orgID, profileID, seedURL)
	if err != nil {
		return nil, normalizeFrontierWriteError(err)
	}
	return profile, nil
}

// CreateFrontierRunFromProfile is createRunFromProfile: it writes the run and
// its root node, then enqueues the root node on the hot frontier queue. A
// non-nil error means the run is not usable.
func (s *Service) CreateFrontierRunFromProfile(ctx context.Context, options CreateRunOptions) (string, error) {
	runID, err := s.createRunFromProfile(ctx, options)
	if err != nil {
		return "", normalizeFrontierWriteError(err)
	}
	return runID, nil
}

// normalizeFrontierWriteError converts a crawlworkflow service error into this
// package's NestError. This package's own errors already are NestError and pass
// through untouched; everything else keeps its identity so the caller still sees
// database and connection failures as 503/500.
func normalizeFrontierWriteError(err error) error {
	if err == nil {
		return nil
	}
	var nest *NestError
	if errors.As(err, &nest) {
		return err
	}
	if status, message, ok := crawlworkflow.ErrorStatus(err); ok {
		return &NestError{Status: status, Message: message}
	}
	return err
}
