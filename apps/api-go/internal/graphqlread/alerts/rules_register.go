package alerts

import (
	"context"
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// RuleQueue is the alerts-queue producer the rule roots require. It is
// satisfied by *alertqueue.Producer; the interface keeps this package free of
// the queue implementation and lets the tests substitute one.
//
// The producer only writes jobs. The NestJS AlertsProcessor stays the single
// consumer of the queue.
type RuleQueue interface {
	// EnqueueRuleCheck adds one evaluation job carrying the request trace id.
	EnqueueRuleCheck(ctx context.Context, ruleID, orgID, traceID string) error
	// EnsureRuleSchedule replaces every schedule of the rule and adds the
	// current interval when the rule is active (the B3 fix).
	EnsureRuleSchedule(ctx context.Context, ruleID, orgID string, checkIntervalSec int, active bool) error
	// RemoveRuleJobs removes every schedule and pending job of the rule.
	RemoveRuleJobs(ctx context.Context, ruleID string) error
}

// ruleService holds the MySQL handle and queue writer shared by the four roots.
type ruleService struct {
	db    *sql.DB
	queue RuleQueue
}

// RegisterRules adds the alert rule unit: the alertRules query and the
// upsertAlertRule, deleteAlertRule and triggerAlertRule mutations.
//
// It registers AlertRuleModel only. AlertChannelModel is shared with the alert
// read roots and the workspace write batch and is registered exactly once by
// the caller (alerts.Register, alerts.RegisterModels or RegisterRules' caller),
// not here.
func RegisterRules(reg *contract.Registry, db *sql.DB, queue RuleQueue) {
	if reg == nil {
		panic("graphqlread: alerts.RegisterRules requires a registry")
	}
	svc := &ruleService{db: db, queue: queue}
	reg.RegisterType("AlertRuleModel", AlertRuleModel{})
	reg.RegisterRoot(contract.Root{
		Name:       "alertRules",
		Permission: "alerts.read",
		Resolve:    contract.Bind(svc.alertRulesResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "upsertAlertRule",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.upsertAlertRuleResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "deleteAlertRule",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.deleteAlertRuleResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "triggerAlertRule",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.triggerAlertRuleResolver),
	})
}

// RegisteredRoots lists the roots RegisterRules adds. The startup log and the
// migration tests use it.
var RegisteredRoots = []string{
	"alertRules",
	"upsertAlertRule",
	"deleteAlertRule",
	"triggerAlertRule",
}
