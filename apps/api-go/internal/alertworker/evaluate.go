package alertworker

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/providers"
	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/queue"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
)

// lastEvaluatedKeyPrefix is the B3 marker key: the epoch millisecond of the last
// evaluation of one rule. It is not part of the NestJS contract; it only lets the
// scan skip rules whose own schedule already evaluated them.
const lastEvaluatedKeyPrefix = "alerts:rule:last-evaluated:"

// defaultRuleDefinition is one system default rule of a metric provider.
type defaultRuleDefinition struct {
	Key            string
	Name           string
	Description    string
	MetricSlug     string
	Operator       string
	ThresholdValue float64
	Severity       string
}

// defaultRuleGroup ties one metric provider to its definitions. The order is the
// order ensureDefaultRules creates them in (crawl_task, realtime_signal,
// pipeline_job) and the id prefix of each rule.
type defaultRuleGroup struct {
	MetricProvider  string
	RuleIDPrefix    string
	CooldownSeconds int
	Definitions     []defaultRuleDefinition
}

// defaultCrawlQualityRules mirrors DEFAULT_CRAWL_QUALITY_RULES.
var defaultCrawlQualityRules = []defaultRuleDefinition{
	{
		Key: "preflight_failure_rate", Name: "Crawl Quality: Preflight Failure Rate High",
		Description:    "Alert when preflight failure rate remains too high.",
		MetricSlug:     "crawl_quality.preflight_failure_rate",
		Operator:       providers.OperatorGte,
		ThresholdValue: 0.15, Severity: "medium",
	},
	{
		Key: "http_304_hit_rate", Name: "Crawl Quality: HTTP 304 Hit Rate Low",
		Description:    "Alert when HTTP 304 hit rate drops below expected baseline.",
		MetricSlug:     "crawl_quality.http_304_hit_rate",
		Operator:       providers.OperatorLte,
		ThresholdValue: 0.05, Severity: "medium",
	},
	{
		Key: "org_hash_dedupe_hit_rate", Name: "Crawl Quality: Org Hash Dedupe Hit Rate High",
		Description:    "Alert when org-level content hash dedupe hit rate spikes.",
		MetricSlug:     "crawl_quality.org_hash_dedupe_hit_rate",
		Operator:       providers.OperatorGte,
		ThresholdValue: 0.3, Severity: "medium",
	},
}

// defaultRealtimeSignalRules mirrors REALTIME_SIGNAL_DEFAULT_RULES.
var defaultRealtimeSignalRules = []defaultRuleDefinition{
	{
		Key: "opensky", Name: "Realtime Signal: Military Flight Activity Surge",
		Description: "Alert when conservative OpenSky military flight detections exceed baseline threshold.",
		MetricSlug:  "realtime.opensky.military_flights", Operator: providers.OperatorGte,
		ThresholdValue: 50, Severity: "medium",
	},
	{
		Key: "opensky_snapshot_health", Name: "Realtime Signal: OpenSky Snapshot Degraded",
		Description: "Alert when the OpenSky military snapshot is stale or the map is temporarily using the previous retained snapshot.",
		MetricSlug:  "realtime.opensky.snapshot_health", Operator: providers.OperatorGte,
		ThresholdValue: 1, Severity: "high",
	},
	{
		Key: "ais", Name: "Realtime Signal: Maritime Disruptions Elevated",
		Description: "Alert when AIS disruptions count crosses the threshold.",
		MetricSlug:  "realtime.ais.disruptions", Operator: providers.OperatorGte,
		ThresholdValue: 5, Severity: "medium",
	},
	{
		Key: "unrest", Name: "Realtime Signal: Unrest Event Spike",
		Description: "Alert when protest/unrest events rise above the configured threshold.",
		MetricSlug:  "realtime.unrest.events", Operator: providers.OperatorGte,
		ThresholdValue: 20, Severity: "medium",
	},
	{
		Key: "outages", Name: "Realtime Signal: Internet Outages Detected",
		Description: "Alert when internet outage annotations increase materially.",
		MetricSlug:  "realtime.outages.internet", Operator: providers.OperatorGte,
		ThresholdValue: 3, Severity: "high",
	},
	{
		Key: "keyword_spike", Name: "Realtime Signal: Keyword Spike",
		Description: "Alert when cross-source keyword spikes are detected in near realtime.",
		MetricSlug:  "realtime.keyword_spike.count", Operator: providers.OperatorGte,
		ThresholdValue: 1, Severity: "medium",
	},
	{
		Key: "pizzint", Name: "Realtime Signal: PizzINT DEFCON Escalation",
		Description: "Alert when PizzINT DEFCON reaches elevated levels.",
		MetricSlug:  "realtime.pizzint.defcon", Operator: providers.OperatorLte,
		ThresholdValue: 2, Severity: "high",
	},
	{
		Key: "gdelt_tension", Name: "Realtime Signal: GDELT Tension Escalation",
		Description: "Alert when bilateral tension score exceeds the configured threshold.",
		MetricSlug:  "realtime.gdelt_tension.max_score", Operator: providers.OperatorGte,
		ThresholdValue: 70, Severity: "high",
	},
	{
		Key: "polymarket_leads", Name: "Realtime Signal: Prediction Leads News",
		Description: "Alert when prediction market movement leads low-coverage news topics.",
		MetricSlug:  "realtime.polymarket_leads.count", Operator: providers.OperatorGte,
		ThresholdValue: 1, Severity: "medium",
	},
}

// defaultPipelineRules mirrors DEFAULT_PIPELINE_RULES.
var defaultPipelineRules = []defaultRuleDefinition{
	{
		Key: "success_rate", Name: "Pipeline: Success Rate Low",
		Description: "Alert when pipeline success rate drops below the expected baseline.",
		MetricSlug:  "pipeline.success_rate", Operator: providers.OperatorLte,
		ThresholdValue: 0.9, Severity: "high",
	},
	{
		Key: "failure_rate", Name: "Pipeline: Failure Rate High",
		Description: "Alert when pipeline failure rate remains too high.",
		MetricSlug:  "pipeline.failure_rate", Operator: providers.OperatorGte,
		ThresholdValue: 0.1, Severity: "high",
	},
	{
		Key: "average_llm_latency_ms", Name: "Pipeline: Average LLM Latency High",
		Description: "Alert when average LLM latency exceeds the operational threshold.",
		MetricSlug:  "pipeline.average_llm_latency_ms", Operator: providers.OperatorGte,
		ThresholdValue: 8000, Severity: "medium",
	},
	{
		Key: "ingestion_p90_ms", Name: "Pipeline: Ingestion P90 High",
		Description: "Alert when p90 ingestion latency exceeds the operational threshold.",
		MetricSlug:  "pipeline.ingestion_p90_ms", Operator: providers.OperatorGte,
		ThresholdValue: 300000, Severity: "medium",
	},
	{
		Key: "ingestion_p99_ms", Name: "Pipeline: Ingestion P99 High",
		Description: "Alert when p99 ingestion latency exceeds the operational threshold.",
		MetricSlug:  "pipeline.ingestion_p99_ms", Operator: providers.OperatorGte,
		ThresholdValue: 900000, Severity: "high",
	},
}

// defaultRuleGroups is ensureDefaultRules' definition order.
var defaultRuleGroups = []defaultRuleGroup{
	{
		MetricProvider:  "crawl_task",
		RuleIDPrefix:    "default-crawl-quality-",
		CooldownSeconds: 3600,
		Definitions:     defaultCrawlQualityRules,
	},
	{
		MetricProvider:  "realtime_signal",
		RuleIDPrefix:    "default-realtime-signal-",
		CooldownSeconds: 1800,
		Definitions:     defaultRealtimeSignalRules,
	},
	{
		MetricProvider:  "pipeline_job",
		RuleIDPrefix:    "default-pipeline-",
		CooldownSeconds: 1800,
		Definitions:     defaultPipelineRules,
	},
}

// ScanActiveRules is the `scan-active-rules` handler: create the missing default
// rules, then enqueue the evaluations of the active rules that are due.
//
// B3: a rule is only enqueued by the scan when it has not been evaluated within
// its own check interval, so a rule whose schedule already ran is not evaluated
// twice in one scan window and a rule with an interval above the scan interval
// is evaluated at its own pace.
func (s *Service) ScanActiveRules(ctx context.Context) error {
	if err := s.ensureDefaultRulesForAllOrgs(ctx); err != nil {
		return err
	}
	rules, err := s.repo.listActiveRules(ctx, s.db)
	if err != nil {
		return err
	}
	due, err := s.dueRuleIDs(ctx, rules)
	if err != nil {
		return err
	}
	if len(due) == 0 {
		return nil
	}
	specs := make([]queue.EvaluateJobSpec, 0, len(due))
	for _, rule := range due {
		specs = append(specs, queue.EvaluateJobSpec{
			RuleID:  rule.ID,
			OrgID:   rule.OrgID,
			TraceID: ensureTraceID(""),
		})
	}
	if err := s.producer.AddEvaluateJobs(ctx, specs); err != nil {
		return err
	}
	// B3: the marker is written when an evaluation starts, but a scan that
	// enqueues a rule must not enqueue it again before that evaluation runs.
	// Recording the enqueue keeps repeated scans in one window idempotent; the
	// per-rule schedules never read the marker, so they are unaffected.
	s.markRulesEnqueued(ctx, due)
	s.logf("alertworker: scan enqueued %d of %d active rule(s)", len(specs), len(rules))
	return nil
}

// markRulesEnqueued records the B3 marker for rules whose evaluation was just
// queued, using one Redis pipeline.
func (s *Service) markRulesEnqueued(ctx context.Context, rules []activeRule) {
	if len(rules) == 0 {
		return
	}
	pipe := s.redis.Pipeline()
	nowMs := s.now().UnixMilli()
	for _, rule := range rules {
		ttl := time.Duration(2*maxInt(60, rule.CheckIntervalSec)) * time.Second
		pipe.Set(ctx, lastEvaluatedKeyPrefix+rule.ID, nowMs, ttl)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		s.logf("alertworker: mark enqueued rules evaluated: %v", err)
	}
}

// dueRuleIDs keeps the rules whose last evaluation is missing or older than
// their check interval. The markers are read with one MGET (O2a): the check is a
// pure read, so batching it changes no state.
func (s *Service) dueRuleIDs(ctx context.Context, rules []activeRule) ([]activeRule, error) {
	if len(rules) == 0 {
		return nil, nil
	}
	keys := make([]string, len(rules))
	for index, rule := range rules {
		keys[index] = lastEvaluatedKeyPrefix + rule.ID
	}
	values, err := s.redis.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("alertworker: read last-evaluated markers: %w", err)
	}
	nowMs := s.now().UnixMilli()
	due := make([]activeRule, 0, len(rules))
	for index, rule := range rules {
		intervalMs := int64(maxInt(60, rule.CheckIntervalSec)) * 1000
		if index < len(values) && values[index] != nil {
			raw, ok := values[index].(string)
			if ok {
				if lastMs, parseErr := strconv.ParseInt(raw, 10, 64); parseErr == nil {
					if nowMs-lastMs < intervalMs {
						continue
					}
				}
			}
		}
		due = append(due, rule)
	}
	return due, nil
}

// markRuleEvaluated records the B3 marker at the start of an evaluation.
func (s *Service) markRuleEvaluated(ctx context.Context, rule Rule) {
	ttlSeconds := int64(2 * maxInt(60, rule.CheckIntervalSec))
	key := lastEvaluatedKeyPrefix + rule.ID
	if err := s.redis.Set(ctx, key, s.now().UnixMilli(), time.Duration(ttlSeconds)*time.Second).Err(); err != nil {
		s.logf("alertworker: mark rule %s evaluated: %v", rule.ID, err)
	}
}

// ensureDefaultRulesForAllOrgs creates the missing system default rules of every
// organization (O1).
//
// The NestJS implementation runs three findMany per organization; this one reads
// every existing (orgId, provider, normalized slug) triple with a single query
// and computes the missing set in memory. The rules that are still inserted keep
// their deterministic id, the same columns and the same follow-up (schedule +
// one immediate evaluation); a primary-key conflict is skipped exactly like the
// P2002 branch.
func (s *Service) ensureDefaultRulesForAllOrgs(ctx context.Context) error {
	orgIDs, err := s.repo.listOrgIDs(ctx, s.db)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	existingRows, err := s.repo.listDefaultRuleKeys(ctx, s.db)
	if err != nil {
		return err
	}
	existing := make(map[string]struct{}, len(existingRows))
	for _, row := range existingRows {
		existing[defaultRuleKeyID(row.OrgID, row.MetricProvider, normalizeMetricSlug(row.MetricSlug))] = struct{}{}
	}
	createdRules := make([]activeRule, 0, 32)
	for _, orgID := range orgIDs {
		for _, group := range defaultRuleGroups {
			for _, definition := range group.Definitions {
				slug := normalizeMetricSlug(definition.MetricSlug)
				key := defaultRuleKeyID(orgID, group.MetricProvider, slug)
				if _, present := existing[key]; present {
					continue
				}
				ruleID := defaultRuleID(group.RuleIDPrefix, definition.Key, orgID)
				metadata, err := json.Marshal(defaultRuleMetadata{
					SystemDefault:  true,
					DefaultRuleKey: definition.Key,
					Version:        systemDefaultRuleVersion,
				})
				if err != nil {
					return err
				}
				created, err := s.repo.insertDefaultRule(ctx, s.db, defaultRuleInsert{
					ID:              ruleID,
					OrgID:           orgID,
					Name:            definition.Name,
					Description:     definition.Description,
					Severity:        definition.Severity,
					MetricProvider:  group.MetricProvider,
					MetricSlug:      slug,
					Operator:        definition.Operator,
					ThresholdValue:  definition.ThresholdValue,
					CooldownSeconds: group.CooldownSeconds,
					Metadata:        metadata,
					Now:             s.now(),
				})
				if err != nil {
					return err
				}
				if !created {
					existing[key] = struct{}{}
					continue
				}
				existing[key] = struct{}{}
				if err := s.producer.EnsureRuleSchedule(ctx, ruleID, orgID, 300); err != nil {
					return err
				}
				if err := s.producer.AddEvaluateJob(ctx, ruleID, orgID, ensureTraceID("")); err != nil {
					return err
				}
				createdRules = append(createdRules, activeRule{ID: ruleID, OrgID: orgID, CheckIntervalSec: 300})
			}
		}
	}
	// A newly created default rule already has its one evaluation queued, so the
	// scan that runs next must not queue it a second time.
	s.markRulesEnqueued(ctx, createdRules)
	return nil
}

// defaultRuleMetadata is the metadata object of a system default rule.
type defaultRuleMetadata struct {
	SystemDefault  bool   `json:"systemDefault"`
	DefaultRuleKey string `json:"defaultRuleKey"`
	Version        int    `json:"version"`
}

func defaultRuleKeyID(orgID, metricProvider, metricSlug string) string {
	return orgID + "\x00" + metricProvider + "\x00" + metricSlug
}

// defaultRuleID mirrors buildDefault*RuleId: the provider prefix, the definition
// key and the org id with every non [a-zA-Z0-9_-] character replaced by "_",
// truncated to the 191 character column width.
func defaultRuleID(prefix, key, orgID string) string {
	id := prefix + key + "-" + normalizeRuleIDPart(orgID)
	if len(id) > 191 {
		id = id[:191]
	}
	return id
}

// normalizeRuleIDPart mirrors orgId.replace(/[^a-zA-Z0-9_-]/g, "_").
func normalizeRuleIDPart(orgID string) string {
	var builder strings.Builder
	builder.Grow(len(orgID))
	for _, r := range orgID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

// EvaluateResult is what EvaluateRule produced. It is returned for tests and for
// callers that want the created rows; the queue handler ignores it.
type EvaluateResult struct {
	Event               EventRow
	ExternalDeliveryIDs []string
	InAppDeliveryIDs    []string
	HasAnyDeliveries    bool
}

// EvaluateRule is the port of AlertsService.evaluateRule.
func (s *Service) EvaluateRule(ctx context.Context, ruleID, expectedOrgID string) (*EvaluateResult, error) {
	rule, links, err := s.repo.loadRuleWithChannels(ctx, s.db, ruleID)
	if err != nil {
		return nil, err
	}
	if rule.ID == "" || rule.Status != StatusActive {
		return nil, nil
	}
	// Defense in depth: a job that declares a target org must never evaluate a
	// rule of another tenant.
	if expectedOrgID != "" && rule.OrgID != expectedOrgID {
		s.logf("alertworker: refusing to evaluate alert rule %s for mismatched org (expected %s, actual %s)",
			ruleID, expectedOrgID, rule.OrgID)
		return nil, nil
	}
	// B3: the marker is written at the start of every evaluation, so the scan can
	// tell a rule that just ran from one that is due.
	s.markRuleEvaluated(ctx, rule)

	now := s.now()
	if rule.LastTriggeredAt != nil {
		nextAllowed := rule.LastTriggeredAt.Add(time.Duration(rule.CooldownSeconds) * time.Second)
		if now.Before(nextAllowed) {
			return nil, nil
		}
	}

	providerRule := providers.Rule{
		ID:              rule.ID,
		OrgID:           rule.OrgID,
		MetricProvider:  rule.MetricProvider,
		MetricSlug:      rule.MetricSlug,
		Operator:        rule.Operator,
		ChangeWindowMin: rule.ChangeWindowMin,
		Metadata:        rule.Metadata,
	}
	if _, ok := s.metrics.Find(providerRule); !ok {
		s.logf("alertworker: alert rule %s has no metric provider registered (%s)", rule.ID, rule.MetricProvider)
		return nil, nil
	}
	evaluation, err := s.metrics.Fetch(ctx, providerRule)
	if err != nil {
		return nil, err
	}
	if evaluation.Latest == nil {
		return nil, nil
	}
	latest := *evaluation.Latest
	triggered, message, triggerContext := shouldTrigger(rule, latest, evaluation.Previous, evaluation.ChangePercent)
	if !triggered {
		return nil, nil
	}

	contextObject := newJSONObject()
	contextObject.SetRawNumber("latest", formatDecimal(latest))
	if evaluation.Previous != nil {
		contextObject.SetRawNumber("previous", formatDecimal(*evaluation.Previous))
	} else {
		contextObject.SetNull("previous")
	}
	if evaluation.ChangePercent != nil {
		contextObject.SetRawNumber("changePercent", formatDecimal(*evaluation.ChangePercent))
	} else {
		contextObject.SetNull("changePercent")
	}
	if providerContext, ok := parseJSONObject(evaluation.Context); ok {
		contextObject.SetObject(providerContext)
	}
	contextObject.SetObject(triggerContext)
	contextObject = normalizeAlertContext(contextObject)

	// B2: only channels of the rule's own organization are eligible. A legacy
	// cross-organization link is skipped (and logged) instead of delivering
	// another tenant's alert to it.
	activeChannels := make([]Channel, 0, len(links))
	for _, link := range links {
		if link.Channel == nil || !link.Channel.IsActive {
			continue
		}
		if link.Channel.OrgID != rule.OrgID {
			s.logf("alertworker: skipping alert channel %s of rule %s: channel org %s does not match rule org %s",
				link.Channel.ID, rule.ID, link.Channel.OrgID, rule.OrgID)
			continue
		}
		activeChannels = append(activeChannels, *link.Channel)
	}

	muteUntilMs := extractMuteUntilMs(rule.Metadata)
	recipients := RecipientResolution{}
	if !IsMutedNow(muteUntilMs, now.UnixMilli()) {
		recipients, err = s.resolveInAppRecipients(ctx, rule)
		if err != nil {
			return nil, err
		}
	}

	persisted, err := s.persistTrigger(ctx, rule, latest, evaluation.ChangePercent, message, contextObject, activeChannels, recipients, now)
	if err != nil {
		return nil, err
	}
	if persisted == nil {
		return nil, nil
	}

	s.logFilteredInAppRecipients(rule, persisted.Event.ID, recipients)

	if len(persisted.ExternalDeliveryIDs) > 0 {
		traceID := ensureTraceID("")
		for _, deliveryID := range persisted.ExternalDeliveryIDs {
			if err := s.producer.AddDeliveryJob(ctx, deliveryID, rule.OrgID, traceID); err != nil {
				return nil, err
			}
		}
	}
	if len(persisted.InAppDeliveries) > 0 {
		// The in-app delivery is awaited inside the evaluation job exactly like
		// the NestJS service: the external channels are queued with retries, but a
		// detached in-app write would die with the process and leave the event and
		// its deliveries pending forever.
		s.deliverInAppNotifications(ctx, rule, persisted.Event, contextObject, persisted.InAppDeliveries)
	}

	streamStatus := EventStatusDelivered
	if persisted.HasAnyDeliveries {
		// The event row was created as pending; the deliveries settle later.
		streamStatus = persisted.Event.Status
	}
	s.publishAlertEvent(ctx, rule, persisted.Event, message, streamStatus, contextObject)
	return persisted.result(), nil
}

// persistedTrigger is the outcome of the claim + event/delivery transaction.
type persistedTrigger struct {
	Event               EventRow
	ExternalDeliveryIDs []string
	InAppDeliveries     []InAppDelivery
	HasAnyDeliveries    bool
}

func (p *persistedTrigger) result() *EvaluateResult {
	externalIDs := p.ExternalDeliveryIDs
	inAppIDs := make([]string, 0, len(p.InAppDeliveries))
	for _, delivery := range p.InAppDeliveries {
		inAppIDs = append(inAppIDs, delivery.ID)
	}
	return &EvaluateResult{
		Event:               p.Event,
		ExternalDeliveryIDs: externalIDs,
		InAppDeliveryIDs:    inAppIDs,
		HasAnyDeliveries:    p.HasAnyDeliveries,
	}
}

// persistTrigger claims the cooldown and writes the event and its deliveries in
// one transaction: a crash after occupying lastTriggeredAt can therefore never
// drop the alert without rows.
func (s *Service) persistTrigger(
	ctx context.Context,
	rule Rule,
	latest float64,
	changePercent *float64,
	message string,
	contextObject *jsonObject,
	activeChannels []Channel,
	recipients RecipientResolution,
	now time.Time,
) (*persistedTrigger, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("alertworker: begin trigger transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	claimed, err := s.repo.claimRuleCooldown(ctx, tx, rule.ID, rule.CooldownSeconds, now)
	if err != nil {
		return nil, err
	}
	if !claimed {
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("alertworker: commit empty trigger transaction: %w", err)
		}
		return nil, nil
	}

	eventID, err := randomRowID()
	if err != nil {
		return nil, fmt.Errorf("alertworker: alert event id: %w", err)
	}
	messageValue := message
	event := EventRow{
		ID:            eventID,
		RuleID:        rule.ID,
		TriggeredAt:   now.UTC().Truncate(time.Millisecond),
		MetricValue:   latest,
		ChangePercent: changePercent,
		Severity:      rule.Severity,
		Status:        EventStatusPending,
		Message:       &messageValue,
		Context:       contextObject.Marshal(),
	}
	if err := s.repo.insertEvent(ctx, tx, eventInsert{
		ID:            event.ID,
		RuleID:        event.RuleID,
		TriggeredAt:   event.TriggeredAt,
		MetricValue:   event.MetricValue,
		ChangePercent: event.ChangePercent,
		Severity:      event.Severity,
		Message:       event.Message,
		Context:       event.Context,
		Now:           now,
	}); err != nil {
		return nil, err
	}

	externalIDs := make([]string, 0, len(activeChannels))
	for _, channel := range activeChannels {
		deliveryID, err := randomRowID()
		if err != nil {
			return nil, fmt.Errorf("alertworker: alert delivery id: %w", err)
		}
		snapshot, err := marshalChannelSnapshot(channel)
		if err != nil {
			return nil, err
		}
		channelID := channel.ID
		if err := s.repo.insertDelivery(ctx, tx, deliveryInsert{
			ID:             deliveryID,
			EventID:        event.ID,
			ChannelID:      &channelID,
			ChannelType:    channel.Type,
			TargetSnapshot: snapshot,
			Now:            now,
		}); err != nil {
			return nil, err
		}
		externalIDs = append(externalIDs, deliveryID)
	}

	inApp := make([]InAppDelivery, 0, len(recipients.AllowedUserIDs))
	for _, userID := range recipients.AllowedUserIDs {
		deliveryID, err := randomRowID()
		if err != nil {
			return nil, fmt.Errorf("alertworker: alert delivery id: %w", err)
		}
		snapshot, err := json.Marshal(inAppTargetSnapshot{UserID: userID})
		if err != nil {
			return nil, err
		}
		if err := s.repo.insertDelivery(ctx, tx, deliveryInsert{
			ID:             deliveryID,
			EventID:        event.ID,
			ChannelType:    ChannelTypeInApp,
			TargetSnapshot: snapshot,
			Now:            now,
		}); err != nil {
			return nil, err
		}
		inApp = append(inApp, InAppDelivery{ID: deliveryID, UserID: userID})
	}

	hasAnyDeliveries := len(externalIDs) > 0 || len(inApp) > 0
	if !hasAnyDeliveries {
		if err := s.repo.markEventDelivered(ctx, tx, event.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("alertworker: commit trigger transaction: %w", err)
	}
	return &persistedTrigger{
		Event:               event,
		ExternalDeliveryIDs: externalIDs,
		InAppDeliveries:     inApp,
		HasAnyDeliveries:    hasAnyDeliveries,
	}, nil
}

// marshalChannelSnapshot renders the whole channel object as targetSnapshot,
// like `targetSnapshot: channel` in NestJS.
func marshalChannelSnapshot(channel Channel) ([]byte, error) {
	snapshot := channelSnapshot{
		ID:        channel.ID,
		OrgID:     channel.OrgID,
		Type:      channel.Type,
		Name:      channel.Name,
		Target:    channel.Target,
		Config:    channel.Config,
		IsActive:  channel.IsActive,
		CreatedAt: channel.CreatedAt.UTC().Format(isoMillisLayout),
		UpdatedAt: channel.UpdatedAt.UTC().Format(isoMillisLayout),
	}
	if len(snapshot.Config) == 0 {
		snapshot.Config = json.RawMessage("null")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, fmt.Errorf("alertworker: encode channel snapshot: %w", err)
	}
	return encoded, nil
}

// isoMillisLayout is the JavaScript Date#toISOString layout.
const isoMillisLayout = "2006-01-02T15:04:05.000Z"

// shouldTrigger is the port of AlertsService.shouldTrigger: the nine operators,
// the exact message strings (JavaScript number interpolation) and the context
// fragments the event inherits.
func shouldTrigger(rule Rule, latest float64, previous, changePercent *float64) (bool, string, *jsonObject) {
	threshold := rule.ThresholdValue
	lower := rule.ThresholdLower
	upper := rule.ThresholdUpper
	contextWithLatest := func() *jsonObject {
		object := newJSONObject()
		object.SetRawNumber("latest", formatDecimal(latest))
		return object
	}
	switch rule.Operator {
	case providers.OperatorGt:
		if threshold == nil || !(latest > *threshold) {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("threshold", formatDecimal(*threshold))
		return true, "Value " + formatDecimal(latest) + " is greater than " + formatDecimal(*threshold), triggerContext
	case providers.OperatorGte:
		if threshold == nil || !(latest >= *threshold) {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("threshold", formatDecimal(*threshold))
		return true, "Value " + formatDecimal(latest) + " is >= " + formatDecimal(*threshold), triggerContext
	case providers.OperatorLt:
		if threshold == nil || !(latest < *threshold) {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("threshold", formatDecimal(*threshold))
		return true, "Value " + formatDecimal(latest) + " is below " + formatDecimal(*threshold), triggerContext
	case providers.OperatorLte:
		if threshold == nil || !(latest <= *threshold) {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("threshold", formatDecimal(*threshold))
		return true, "Value " + formatDecimal(latest) + " is <= " + formatDecimal(*threshold), triggerContext
	case providers.OperatorEq:
		if threshold == nil || latest != *threshold {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("threshold", formatDecimal(*threshold))
		return true, "Value " + formatDecimal(latest) + " equals " + formatDecimal(*threshold), triggerContext
	case providers.OperatorOutsideRange:
		if lower == nil || upper == nil {
			return false, "", nil
		}
		if !(latest < *lower || latest > *upper) {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("lower", formatDecimal(*lower))
		triggerContext.SetRawNumber("upper", formatDecimal(*upper))
		return true, "Value " + formatDecimal(latest) + " is outside " + formatDecimal(*lower) + "-" + formatDecimal(*upper), triggerContext
	case providers.OperatorWithinRange:
		if lower == nil || upper == nil {
			return false, "", nil
		}
		if !(latest >= *lower && latest <= *upper) {
			return false, "", nil
		}
		triggerContext := contextWithLatest()
		triggerContext.SetRawNumber("lower", formatDecimal(*lower))
		triggerContext.SetRawNumber("upper", formatDecimal(*upper))
		return true, "Value " + formatDecimal(latest) + " is within " + formatDecimal(*lower) + "-" + formatDecimal(*upper), triggerContext
	case providers.OperatorChangeUpPct:
		if changePercent == nil || threshold == nil || !(*changePercent >= *threshold) {
			return false, "", nil
		}
		triggerContext := newJSONObject()
		triggerContext.SetRawNumber("changePercent", formatDecimal(*changePercent))
		return true, "Change " + FormatJSFixed(*changePercent, 2) + "% >= " + formatDecimal(*threshold) + "%", triggerContext
	case providers.OperatorChangeDownPct:
		if changePercent == nil || threshold == nil || !(*changePercent <= -1*(*threshold)) {
			return false, "", nil
		}
		triggerContext := newJSONObject()
		triggerContext.SetRawNumber("changePercent", formatDecimal(*changePercent))
		return true, "Change " + FormatJSFixed(*changePercent, 2) + "% <= -" + formatDecimal(*threshold) + "%", triggerContext
	default:
		return false, "", nil
	}
}

// normalizeAlertContext is the port of AlertsService.normalizeAlertContext: it
// rewrites the country code to the alpha-3 form and fills the country name when
// the provider did not provide one.
func normalizeAlertContext(context *jsonObject) *jsonObject {
	if context == nil {
		return nil
	}
	normalized := newJSONObject()
	normalized.SetObject(context)

	rawCountry, hasCountry := stringField(normalized, "country")
	rawCountryCode, hasCountryCode := stringField(normalized, "countryCode")
	countryValue := rawCountry
	if hasCountryCode {
		countryValue = rawCountryCode
	}
	countryCode := dashboardwarmap.NormalizeCountryCode(countryValue)
	if countryCode == "" {
		return normalized
	}
	normalized.SetString("countryCode", countryCode)

	if nameRaw, hasName := normalized.Get("countryName"); hasName && !isFalsyJSON(nameRaw) {
		return normalized
	}
	rawCountryLooksLikeCode := false
	if hasCountry {
		trimmed := strings.TrimSpace(rawCountry)
		rawCountryLooksLikeCode = isAlphaCode(trimmed)
	}
	if hasCountry && rawCountry != countryCode && !rawCountryLooksLikeCode {
		normalized.SetString("countryName", rawCountry)
		return normalized
	}
	if name := dashboardwarmap.CountryName(countryCode); name != "" {
		normalized.SetString("countryName", name)
	}
	return normalized
}

// isFalsyJSON mirrors JavaScript truthiness for the countryName guard: null,
// false, 0 (including 0.0 and -0), "" and an empty object are falsy. An empty
// array/object is truthy in JavaScript, so only the string/number/boolean/null
// cases are handled here.
func isFalsyJSON(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "", "null", "false", `""`:
		return true
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		return number == 0
	}
	return false
}

// isAlphaCode reports whether value matches /^[A-Za-z]{2,3}$/.
func isAlphaCode(value string) bool {
	length := len(value)
	if length < 2 || length > 3 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		default:
			return false
		}
	}
	return true
}

// logFilteredInAppRecipients mirrors logFilteredInAppRecipients.
func (s *Service) logFilteredInAppRecipients(rule Rule, eventID string, resolution RecipientResolution) {
	if len(resolution.MissingPermissionUserIDs) == 0 {
		return
	}
	sample := resolution.MissingPermissionUserIDs
	if len(sample) > filteredRecipientSampleLimit {
		sample = sample[:filteredRecipientSampleLimit]
	}
	s.logf("alertworker: filtered in-app alert recipients without %s (org=%s rule=%s event=%s candidates=%d allowed=%d filtered=%d sample=%s hasMore=%t)",
		alertsReadPermission, rule.OrgID, rule.ID, eventID,
		len(resolution.CandidateUserIDs), len(resolution.AllowedUserIDs), len(resolution.MissingPermissionUserIDs),
		strings.Join(sample, ","), len(resolution.MissingPermissionUserIDs) > len(sample))
}
