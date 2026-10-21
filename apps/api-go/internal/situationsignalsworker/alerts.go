package situationsignalsworker

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// OREF default alert rule constants, copied from
// apps/api/src/modules/situation-monitor/signal-metrics.constants.ts and
// packages/utils/src/alert-metric-slugs.ts.
const (
	orefActiveAlertsMetricSlug = "situation.oref.active_alerts"
	orefHistory24hMetricSlug   = "situation.oref.history_24h"

	orefDefaultRuleTickGateKey = "cron:situation-monitor-oref-default-rules:tick-gate"
	// orefDefaultRuleTickGateTTL is OREF_DEFAULT_RULE_TICK_GATE_TTL_MS (55s).
	orefDefaultRuleTickGateTTL = 55 * time.Second
	// orefEnsureRulesInterval and orefAlertCheckInterval are the process-local
	// throttles of ensureOrefDefaultRules (60s) and triggerOrefAlertChecks
	// (30s).
	orefEnsureRulesInterval = 60 * time.Second
	orefAlertCheckInterval  = 30 * time.Second

	// orefDefaultRuleChangeWindowMin / CooldownSeconds / CheckIntervalSec are
	// the literal rule fields ensureOrefDefaultRules writes.
	orefDefaultRuleChangeWindowMin = 60
	orefDefaultRuleCooldownSeconds = 300
	orefDefaultRuleCheckInterval   = 300
	// orefDefaultRuleSeverityHigh/Medium map the metric slug to the Prisma
	// AlertSeverity enum value.
	orefDefaultRuleSeverityHigh   = "high"
	orefDefaultRuleSeverityMedium = "medium"
	orefDefaultRuleStatusActive   = "active"
	orefDefaultRuleOperatorGte    = "gte"
	orefSystemMetricProvider      = "system_metric"
	// orefDefaultRuleMetadata is the Prisma JSON object written to
	// AlertRule.metadata; key order source, systemDefault.
	orefDefaultRuleMetadata = `{"source":"situation-monitor-signals","systemDefault":true}`
)

// orefAlertRuleDefinition is one default rule definition.
type orefAlertRuleDefinition struct {
	Slug           string
	Name           string
	Description    string
	ThresholdValue int
}

// orefDefaultAlertRules mirrors SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES.
var orefDefaultAlertRules = []orefAlertRuleDefinition{
	{
		Slug:           orefActiveAlertsMetricSlug,
		Name:           "Situation Monitor: OREF Active Alerts",
		Description:    "Trigger when OREF active alerts are detected.",
		ThresholdValue: 1,
	},
	{
		Slug:           orefHistory24hMetricSlug,
		Name:           "Situation Monitor: OREF 24h Alert Volume Spike",
		Description:    "Trigger when OREF 24h alert volume exceeds baseline.",
		ThresholdValue: 25,
	},
}

// buildDefaultOrefRuleID mirrors buildDefaultOrefRuleId:
// "default-oref-alert-" + the first 40 hex characters of sha1(orgId:slug).
func buildDefaultOrefRuleID(orgID, metricSlug string) string {
	digest := sha1.Sum([]byte(orgID + ":" + metricSlug))
	return "default-oref-alert-" + hex.EncodeToString(digest[:])[:40]
}

// ensureOrefDefaultRules mirrors ensureOrefDefaultRules.
//
// NestJS fans the missing-rule groups out with
// situationMonitorOrefDefaultRuleOrgConcurrency goroutines. Go inserts the
// rules sequentially: the queries are small, the work runs at most once per
// minute and the tick gate keeps it on a single instance, so serial execution
// is equivalent and avoids another MySQL connection fan-out.
//
// A lease or query failure is returned to the caller because NestJS lets it
// bubble into pollOrefOnce's catch block (which records lastError); individual
// rule insertions are logged and do not abort the remaining orgs, matching the
// settleWithConcurrency rejection handling.
func (s *Service) ensureOrefDefaultRules(ctx context.Context) error {
	now := s.now()
	if !s.orefEnsureRulesAt.IsZero() && now.Sub(s.orefEnsureRulesAt) < orefEnsureRulesInterval {
		return nil
	}
	s.orefEnsureRulesAt = now

	if s.db == nil {
		return nil
	}

	claimed, err := rediscache.ClaimTick(ctx, s.redis, orefDefaultRuleTickGateKey, orefDefaultRuleTickGateTTL, now)
	if err != nil {
		return fmt.Errorf("claim oref default rule tick gate: %w", err)
	}
	if !claimed {
		s.logf("situationsignalsworker: skipped OREF default alert rule maintenance because another instance claimed this interval")
		return nil
	}

	orgIDs, err := listActiveOrgIDs(ctx, s.db)
	if err != nil {
		return fmt.Errorf("list active orgs: %w", err)
	}
	if len(orgIDs) == 0 {
		return nil
	}

	existing, err := listExistingOrefRuleKeys(ctx, s.db)
	if err != nil {
		return fmt.Errorf("list existing OREF default rules: %w", err)
	}

	for _, orgID := range orgIDs {
		for _, definition := range orefDefaultAlertRules {
			key := orgID + ":" + definition.Slug
			if _, ok := existing[key]; ok {
				continue
			}
			if err := insertDefaultOrefRule(ctx, s.db, orgID, definition, now); err != nil {
				if isDuplicateKeyError(err) {
					// P2002 is ignored by NestJS too: another instance inserted
					// the row between the read and the write.
					s.logf("situationsignalsworker: default OREF alert rule already exists for org %s slug %s", orgID, definition.Slug)
					continue
				}
				s.logf("situationsignalsworker: failed to ensure OREF default alert rule for org %s: %v", orgID, err)
			}
		}
	}
	return nil
}

// triggerOrefAlertChecks mirrors triggerOrefAlertChecks: it runs at most once
// per 30s, ensures the default rules exist and enqueues one evaluation job per
// active system-metric rule. Enqueue failures are logged and do not abort the
// remaining rules (Promise.allSettled); a rule maintenance/query failure is
// returned so pollOrefOnce can record it in lastError like its NestJS catch
// block does.
func (s *Service) triggerOrefAlertChecks(ctx context.Context) error {
	now := s.now()
	if !s.lastOrefAlertRuleCheckAt.IsZero() && now.Sub(s.lastOrefAlertRuleCheckAt) < orefAlertCheckInterval {
		return nil
	}
	s.lastOrefAlertRuleCheckAt = now

	if err := s.ensureOrefDefaultRules(ctx); err != nil {
		return err
	}
	if s.db == nil || s.alerts == nil {
		return nil
	}

	ruleIDs, orgIDs, err := listActiveOrefRuleTargets(ctx, s.db)
	if err != nil {
		return fmt.Errorf("list active OREF alert rules: %w", err)
	}
	for index := range ruleIDs {
		traceID := httpx.EnsureTraceID("")
		if err := s.alerts.EnqueueRuleCheck(ctx, ruleIDs[index], orgIDs[index], traceID); err != nil {
			s.logf("situationsignalsworker: enqueue OREF alert rule check failed: rule=%s err=%v", ruleIDs[index], err)
		}
	}
	return nil
}

// listActiveOrgIDs mirrors ActiveOrgRegistryService.listActiveOrgs:
// Org rows with isActive = true ordered by id ascending. The NestJS service
// caches the list in Redis for 15s; this query runs at most once per minute
// behind the tick gate, so it reads MySQL directly instead of duplicating the
// cache envelope.
func listActiveOrgIDs(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = 1 ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	orgIDs := make([]string, 0, 32)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, err
		}
		orgIDs = append(orgIDs, orgID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return orgIDs, nil
}

// listExistingOrefRuleKeys mirrors the existing-rule query and set key
// `${orgId}:${String(metricSlug).trim()}`.
func listExistingOrefRuleKeys(ctx context.Context, db *sql.DB) (map[string]struct{}, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT `orgId`, `metricSlug` FROM `AlertRule` WHERE `metricProvider` = ? AND `metricSlug` IN (?, ?)",
		orefSystemMetricProvider, orefActiveAlertsMetricSlug, orefHistory24hMetricSlug,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	keys := make(map[string]struct{}, 64)
	for rows.Next() {
		var orgID string
		var metricSlug sql.NullString
		if err := rows.Scan(&orgID, &metricSlug); err != nil {
			return nil, err
		}
		if !metricSlug.Valid {
			continue
		}
		keys[orgID+":"+strings.TrimSpace(metricSlug.String)] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return keys, nil
}

// insertDefaultOrefRule mirrors the prisma.alertRule.create call.
func insertDefaultOrefRule(ctx context.Context, db *sql.DB, orgID string, definition orefAlertRuleDefinition, now time.Time) error {
	severity := orefDefaultRuleSeverityHigh
	if definition.Slug == orefHistory24hMetricSlug {
		severity = orefDefaultRuleSeverityMedium
	}
	_, err := db.ExecContext(ctx,
		"INSERT INTO `AlertRule` ("+
			"`id`, `orgId`, `name`, `description`, `severity`, `status`, `metricProvider`, `dataItemId`, `metricSlug`, "+
			"`operator`, `thresholdValue`, `thresholdLower`, `thresholdUpper`, `changeWindowMin`, `cooldownSeconds`, "+
			"`checkIntervalSec`, `lastTriggeredAt`, `metadata`, `createdById`, `createdAt`, `updatedAt`"+
			") VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?)",
		buildDefaultOrefRuleID(orgID, definition.Slug),
		orgID,
		definition.Name,
		definition.Description,
		severity,
		orefDefaultRuleStatusActive,
		orefSystemMetricProvider,
		definition.Slug,
		orefDefaultRuleOperatorGte,
		definition.ThresholdValue,
		orefDefaultRuleChangeWindowMin,
		orefDefaultRuleCooldownSeconds,
		orefDefaultRuleCheckInterval,
		orefDefaultRuleMetadata,
		now,
		now,
	)
	return err
}

// listActiveOrefRuleTargets mirrors the findMany in triggerOrefAlertChecks.
func listActiveOrefRuleTargets(ctx context.Context, db *sql.DB) ([]string, []string, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT `id`, `orgId` FROM `AlertRule` WHERE `status` = ? AND `metricProvider` = ? AND `metricSlug` IN (?, ?)",
		orefDefaultRuleStatusActive, orefSystemMetricProvider, orefActiveAlertsMetricSlug, orefHistory24hMetricSlug,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var ruleIDs []string
	var orgIDs []string
	for rows.Next() {
		var ruleID string
		var orgID string
		if err := rows.Scan(&ruleID, &orgID); err != nil {
			return nil, nil, err
		}
		ruleIDs = append(ruleIDs, ruleID)
		orgIDs = append(orgIDs, orgID)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return ruleIDs, orgIDs, nil
}

// isDuplicateKeyError reports MySQL ER_DUP_ENTRY, the error Prisma surfaces as
// P2002 and ensureOrefDefaultRules ignores.
func isDuplicateKeyError(err error) bool {
	var mysqlError *mysql.MySQLError
	if errors.As(err, &mysqlError) {
		return mysqlError.Number == 1062
	}
	return false
}
