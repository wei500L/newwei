package crawlfrontierllm

import (
	"context"
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// Options wires the shared handles. DB and Redis are required in go mode.
type Options struct {
	DB       *sql.DB
	Redis    *redis.Client
	Enqueuer FrontierEnqueuer
	LLM      FrontierLLM
	// Workflows compiles the profile overlay the same way the NestJS service
	// does; nil keeps the base profile unchanged.
	Workflows *crawlworkflow.Service
	// Now overrides the clock; tests only.
	Now func() time.Time
}

// FrontierEnqueuer is the crawlqueue producer surface the chain uses. Keeping
// it an interface lets the tests assert the exact job payload without Redis.
type FrontierEnqueuer interface {
	EnqueueFrontierNode(ctx context.Context, options crawlqueue.EnqueueFrontierNodeOptions) error
	EnqueueFrontierLlmJudge(ctx context.Context, options crawlqueue.EnqueueFrontierLlmJudgeOptions) error
	EnqueueFrontierLlmLearn(ctx context.Context, options crawlqueue.EnqueueFrontierLlmLearnOptions) error
}

// FrontierLLM is the judge/learn model surface. LLMClient implements it; the
// tests use a fake.
type FrontierLLM interface {
	JudgeCandidates(ctx context.Context, input JudgeInput) (JudgeResult, error)
	LearnShadowProfile(ctx context.Context, input LearnInput) (*LearningSuggestion, error)
}

// Service carries the two queue chains.
type Service struct {
	db        *sql.DB
	redis     *redis.Client
	enqueuer  FrontierEnqueuer
	llm       FrontierLLM
	workflows *crawlworkflow.Service
	now       func() time.Time
}

// New builds the chain service.
func New(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		db:        options.DB,
		redis:     options.Redis,
		enqueuer:  options.Enqueuer,
		llm:       options.LLM,
		workflows: options.Workflows,
		now:       now,
	}
}

// nowISO is new Date().toISOString() at the service clock.
func (s *Service) nowISO() string {
	return nestISOString(s.now())
}

// nowMillisValue is Date.now() at the service clock.
func (s *Service) nowMillisValue() int64 {
	return s.now().UnixMilli()
}
