package crawlfrontierllm

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
)

// RuntimeOptions wires the whole ownership switch: one producer, one LLM
// client and two single-concurrency workers.
type RuntimeOptions struct {
	DB           *sql.DB
	Redis        *redis.Client
	RedisOptions *redis.Options
	Env          LLMGatewayEnv
	Logs         RequestLogSink
	Workflows    *crawlworkflow.Service
	// Mongo is the owned request-log connection opened by the wiring when no
	// shared connection existed; Runtime closes it after both workers drain.
	Mongo *dashboardstats.Connection
}

// Runtime owns the two Frontier LLM workers.
type Runtime struct {
	service  *Service
	judge    *Worker
	learn    *Worker
	ownRedis *redis.Client
	mongo    *dashboardstats.Connection
}

// NewRuntime builds the service and both queue consumers. No Redis command is
// issued until Start.
func NewRuntime(options RuntimeOptions) (*Runtime, error) {
	if options.DB == nil || options.RedisOptions == nil {
		return nil, fmt.Errorf("crawlfrontierllm: runtime requires mysql and redis")
	}
	ownRedis := (*redis.Client)(nil)
	if options.Redis == nil {
		ownRedis = redis.NewClient(options.RedisOptions)
		options.Redis = ownRedis
	}
	producer := crawlqueue.NewProducer(crawlqueue.Options{Redis: options.Redis, DB: options.DB})
	llm := NewLLMClient(LLMClientOptions{DB: options.DB, Env: options.Env, Sink: options.Logs})
	service := New(Options{
		DB: options.DB, Redis: options.Redis, Enqueuer: producer, LLM: llm,
		Workflows: options.Workflows,
	})
	runtime := &Runtime{service: service, ownRedis: ownRedis, mongo: options.Mongo}
	var err error
	runtime.judge, err = newWorker(JudgeQueueName, options.Redis, newBlockingClient(options.RedisOptions, options.RedisOptions.DB), runtime.dispatch)
	if err != nil {
		if ownRedis != nil {
			_ = ownRedis.Close()
		}
		return nil, err
	}
	runtime.learn, err = newWorker(LearnQueueName, options.Redis, newBlockingClient(options.RedisOptions, options.RedisOptions.DB), runtime.dispatch)
	if err != nil {
		_ = runtime.judge.Close(context.Background())
		if ownRedis != nil {
			_ = ownRedis.Close()
		}
		return nil, err
	}
	return runtime, nil
}

// Service exposes the chain service (tests and handlers).
func (r *Runtime) Service() *Service {
	if r == nil {
		return nil
	}
	return r.service
}

// Start starts both workers. A failure stops the worker that already started.
func (r *Runtime) Start(ctx context.Context) error {
	if r == nil {
		return fmt.Errorf("crawlfrontierllm: runtime is nil")
	}
	if err := r.judge.Start(ctx); err != nil {
		return err
	}
	if err := r.learn.Start(ctx); err != nil {
		_ = r.judge.Close(context.Background())
		return err
	}
	return nil
}

// Close drains both workers.
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var firstErr error
	if err := r.learn.Close(ctx); err != nil {
		firstErr = err
	}
	if err := r.judge.Close(ctx); err != nil && firstErr == nil {
		firstErr = err
	}
	if r.ownRedis != nil {
		if err := r.ownRedis.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if r.mongo != nil {
		if err := r.mongo.Disconnect(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// dispatch is createLlmWorker's jobKind switch. An unknown kind or a known kind
// without its payload returns {inserted:0, skipped:0} and completes normally.
func (r *Runtime) dispatch(ctx context.Context, data JobData) (any, error) {
	switch data.JobKind {
	case "frontier_llm_judge":
		if data.FrontierLlmJudge != nil {
			return r.service.ProcessQueuedLlmJudge(ctx, data.OrgID, *data.FrontierLlmJudge)
		}
	case "frontier_llm_learn":
		if data.FrontierLlmLearn != nil {
			return r.service.ProcessQueuedLlmLearn(ctx, data.OrgID, *data.FrontierLlmLearn)
		}
	}
	return CrawlExecutionSummary{}, nil
}
