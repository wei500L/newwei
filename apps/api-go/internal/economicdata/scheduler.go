package economicdata

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/economicqueue"
)

const repeatableJobsLockKey = "akshare:repeatable-jobs:lock"

type schedulerConfig struct {
	ItemID         string
	Slug           string
	Frequency      Frequency
	RepeatCron     *string
	IsEnabled      bool
	ProviderKind   ProviderKind
	RequiresSecret string
}

// EnsureRepeatableJobs mirrors AkshareService.ensureRepeatableJobs: acquire the
// shared PX/NX lock for at most five seconds, synchronize the repeat set, then
// release only our own token.
func (s *Service) EnsureRepeatableJobs(ctx context.Context) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	lockID := fmt.Sprintf("%d:%d", time.Now().UnixNano(), time.Now().Unix())
	deadline := time.Now().Add(5 * time.Second)
	for {
		ok, err := s.redis.SetNX(ctx, repeatableJobsLockKey, lockID, 60*time.Second).Result()
		if err != nil {
			return err
		}
		if ok {
			break
		}
		if time.Now().After(deadline) {
			log.Printf("economicdata: skipping repeatable job sync, lock held by another instance")
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	defer func() {
		release := `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`
		releaseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.redis.Eval(releaseCtx, release, []string{repeatableJobsLockKey}, lockID).Err(); err != nil {
			log.Printf("economicdata: failed to release repeatable jobs lock: %v", err)
		}
	}()
	return s.SyncRepeatableJobs(ctx)
}

// SyncRepeatableJobs reconciles Redis against EconomicDataFetchConfig. It never
// drains the queue and only removes repeat entries this catalog owns.
func (s *Service) SyncRepeatableJobs(ctx context.Context) error {
	if s == nil || s.db == nil || s.queue == nil {
		return fmt.Errorf("economicdata: schedule requires mysql and redis")
	}
	configs, err := s.loadSchedulerConfigs(ctx)
	if err != nil {
		return err
	}
	existing, err := s.queue.ListRepeatable(ctx)
	if err != nil {
		return err
	}
	availabilityCache := map[ProviderKind]bool{}
	availableByItem := map[string]bool{}
	errorByItem := map[string]string{}
	for _, config := range configs {
		if !config.IsEnabled {
			continue
		}
		available, ok := availabilityCache[config.ProviderKind]
		if !ok {
			available = s.providerAvailable(ctx, config.ProviderKind)
			availabilityCache[config.ProviderKind] = available
		}
		availableByItem[config.ItemID] = available
		if !available {
			errorByItem[config.ItemID] = providerUnavailableError(config)
			if err := s.markConfigUnavailable(ctx, config.ItemID, errorByItem[config.ItemID]); err != nil {
				log.Printf("economicdata: mark config unavailable %s: %v", config.Slug, err)
			}
		}
	}

	smoothed := s.buildSmoothedRepeatPatterns(configs, availableByItem)
	configByJobName := map[string]schedulerConfig{}
	for _, config := range configs {
		configByJobName[buildJobName(config.ItemID)] = config
	}
	for _, job := range existing {
		config, ok := configByJobName[job.Name]
		if !ok || !config.IsEnabled || !availableByItem[config.ItemID] {
			if err := s.queue.RemoveRepeatable(ctx, job.Key); err != nil {
				return err
			}
		}
	}

	existingByName := map[string]economicqueue.RepeatableJob{}
	for _, job := range existing {
		existingByName[job.Name] = job
	}
	now := time.Now().UnixMilli()
	for _, config := range configs {
		if !config.IsEnabled || !availableByItem[config.ItemID] {
			continue
		}
		jobName := buildJobName(config.ItemID)
		repeat := s.buildRepeatOptions(config.Frequency, config.RepeatCron, smoothed[config.ItemID])
		existingJob, hasExisting := existingByName[jobName]
		resetOverdue := hasExisting && s.shouldResetOverdueHighFrequencyJob(config.Frequency, config.RepeatCron, existingJob, now)
		if hasExisting && !resetOverdue && repeatMatches(existingJob, repeat) {
			continue
		}
		if hasExisting {
			if err := s.queue.RemoveRepeatable(ctx, existingJob.Key); err != nil {
				return err
			}
		}
		if resetOverdue && repeat.Pattern != "" {
			start := time.Now()
			repeat.StartDate = &start
		}
		if _, err := s.queue.AddRepeat(ctx, jobName, economicqueue.JobData{DataItemID: config.Slug}, repeat); err != nil {
			return err
		}
	}

	names := map[string]bool{}
	for _, config := range configs {
		if config.IsEnabled && config.RepeatCron == nil && (config.Frequency == FrequencyRealtime || config.Frequency == FrequencyHourly) {
			names[buildJobName(config.ItemID)] = true
		}
	}
	if s.env.ScheduleSmoothing && len(names) > 0 {
		removed, err := s.queue.ClearStaleHighFrequencyQueuedJobs(ctx, names, time.Now())
		if err != nil {
			return err
		}
		if removed > 0 {
			log.Printf("economicdata: removed %d stale high-frequency queued jobs", removed)
		}
	}
	return nil
}

func (s *Service) loadSchedulerConfigs(ctx context.Context) ([]schedulerConfig, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT f.`itemId`, f.`frequency`, f.`repeatCron`, f.`isEnabled`, i.`slug`, i.`metadata` "+
			"FROM `EconomicDataFetchConfig` f INNER JOIN `EconomicDataItem` i ON i.`id` = f.`itemId`")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]schedulerConfig, 0)
	for rows.Next() {
		var (
			config     schedulerConfig
			repeatCron sql.NullString
			metaRaw    []byte
		)
		if err := rows.Scan(&config.ItemID, &config.Frequency, &repeatCron, &config.IsEnabled, &config.Slug, &metaRaw); err != nil {
			return nil, err
		}
		if repeatCron.Valid {
			config.RepeatCron = &repeatCron.String
		}
		meta := parseItemMetadata(metaRaw)
		config.ProviderKind = parseProviderKind(meta.ProviderKind)
		config.RequiresSecret = parseRequiredSecret(meta.RequiresSecret)
		out = append(out, config)
	}
	return out, rows.Err()
}

func (s *Service) providerAvailable(ctx context.Context, kind ProviderKind) bool {
	if s == nil || s.keys == nil {
		return false
	}
	switch kind {
	case ProviderAkshare:
		return s.env.AkshareEnabled
	case ProviderFinnhub:
		key, err := s.keys.resolve(ctx, "finnhubApiKey")
		return err == nil && key != ""
	case ProviderFred:
		key, err := s.keys.resolve(ctx, "fredApiKey")
		return err == nil && key != ""
	case ProviderYfinance:
		return true
	default:
		return false
	}
}

func providerUnavailableError(config schedulerConfig) string {
	if config.RequiresSecret != "" {
		return "missing_api_key:" + config.RequiresSecret
	}
	return "provider_disabled"
}

func (s *Service) markConfigUnavailable(ctx context.Context, itemID, message string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE `EconomicDataFetchConfig` SET `lastRunAt` = ?, `lastStatus` = 'failed', `lastError` = ?, `updatedAt` = ? WHERE `itemId` = ?",
		time.Now().UTC(), message, time.Now().UTC(), itemID)
	return err
}

func (s *Service) buildRepeatOptions(frequency Frequency, cron *string, smoothedPattern string) economicqueue.RepeatOptions {
	if cron != nil && *cron != "" {
		return economicqueue.RepeatOptions{Pattern: *cron}
	}
	if smoothedPattern != "" {
		return economicqueue.RepeatOptions{Pattern: smoothedPattern}
	}
	switch frequency {
	case FrequencyRealtime:
		return economicqueue.RepeatOptions{Every: 30_000}
	case FrequencyHourly:
		return economicqueue.RepeatOptions{Every: 60 * 60 * 1000}
	case FrequencyDaily:
		return economicqueue.RepeatOptions{Every: 24 * 60 * 60 * 1000}
	case FrequencyWeekly:
		return economicqueue.RepeatOptions{Every: 7 * 24 * 60 * 60 * 1000}
	case FrequencyMonthly:
		return economicqueue.RepeatOptions{Pattern: "0 0 1 * *"}
	default:
		return economicqueue.RepeatOptions{Every: 24 * 60 * 60 * 1000}
	}
}

func (s *Service) buildSmoothedRepeatPatterns(configs []schedulerConfig, available map[string]bool) map[string]string {
	patterns := map[string]string{}
	if !s.env.ScheduleSmoothing {
		return patterns
	}
	byFrequency := map[Frequency][]schedulerConfig{}
	for _, config := range configs {
		if config.RepeatCron != nil || !available[config.ItemID] {
			continue
		}
		byFrequency[config.Frequency] = append(byFrequency[config.Frequency], config)
	}
	for frequency, entries := range byFrequency {
		sorted := append([]schedulerConfig(nil), entries...)
		sortSchedulerConfigs(sorted)
		slotCount := repeatSlotCount(frequency)
		if slotCount <= 0 {
			continue
		}
		for index, entry := range sorted {
			slot := computeDistributedSlot(index, len(sorted), slotCount)
			patterns[entry.ItemID] = buildPatternForSlot(frequency, slot)
		}
	}
	return patterns
}

func sortSchedulerConfigs(configs []schedulerConfig) {
	for i := 1; i < len(configs); i++ {
		for j := i; j > 0 && strings.Compare(configs[j-1].Slug, configs[j].Slug) > 0; j-- {
			configs[j-1], configs[j] = configs[j], configs[j-1]
		}
	}
}

func repeatSlotCount(frequency Frequency) int {
	switch frequency {
	case FrequencyRealtime:
		return 30
	case FrequencyHourly:
		return 60 * 60
	case FrequencyDaily:
		return 24 * 60 * 60
	case FrequencyWeekly:
		return 7 * 24 * 60 * 60
	case FrequencyMonthly:
		return 28 * 24 * 60 * 60
	default:
		return 0
	}
}

func computeDistributedSlot(index, total, slotCount int) int {
	if total <= 1 {
		return 0
	}
	slot := ((index*2 + 1) * slotCount) / (total * 2)
	if slot >= slotCount {
		slot = slotCount - 1
	}
	if slot < 0 {
		slot = 0
	}
	return slot
}

func buildPatternForSlot(frequency Frequency, slot int) string {
	switch frequency {
	case FrequencyRealtime:
		return fmt.Sprintf("%d,%d * * * * *", slot, slot+30)
	case FrequencyHourly:
		return fmt.Sprintf("%d %d * * * *", slot%60, slot/60)
	case FrequencyDaily:
		return fmt.Sprintf("%d %d %d * * *", slot%60, (slot%3600)/60, slot/3600)
	case FrequencyWeekly:
		day := slot / (24 * 60 * 60)
		daySlot := slot % (24 * 60 * 60)
		return fmt.Sprintf("%d %d %d * * %d", daySlot%60, (daySlot%3600)/60, daySlot/3600, day)
	case FrequencyMonthly:
		day := slot/(24*60*60) + 1
		daySlot := slot % (24 * 60 * 60)
		return fmt.Sprintf("%d %d %d %d * *", daySlot%60, (daySlot%3600)/60, daySlot/3600, day)
	default:
		return "0 0 1 * *"
	}
}

func (s *Service) shouldResetOverdueHighFrequencyJob(frequency Frequency, cron *string, existing economicqueue.RepeatableJob, now int64) bool {
	if !s.env.ScheduleSmoothing || cron != nil {
		return false
	}
	if frequency != FrequencyRealtime && frequency != FrequencyHourly {
		return false
	}
	return existing.Next > 0 && existing.Next < now
}

func repeatMatches(job economicqueue.RepeatableJob, repeat economicqueue.RepeatOptions) bool {
	if repeat.Every > 0 {
		parsed, err := strconv.ParseInt(job.Every, 10, 64)
		return err == nil && parsed == repeat.Every
	}
	if repeat.Pattern != "" {
		return job.Pattern == repeat.Pattern
	}
	return false
}

func buildJobName(itemID string) string { return "fetch:" + itemID }

func (s *Service) releaseLock(ctx context.Context, key, token string) {
	script := `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`
	_ = s.redis.Eval(ctx, script, []string{key}, token).Err()
}
