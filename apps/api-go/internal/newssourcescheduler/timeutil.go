package newssourcescheduler

import (
	"encoding/json"
	"math"
	"time"
	// Embed the IANA database so a source timezone resolves identically on a
	// minimal container image; a missing zone would silently change nextRunAt.
	_ "time/tzdata"
)

// This file ports computeNextRunAt, computeNextIntervalRunAt, normalizeCronSchedule
// and isWithinCronWindow. The cron branch keeps cron-parser's shape exactly:
// the base is max(scheduledFor, now), at most 200 consecutive occurrences are
// inspected and the first one inside the execution window wins; when none of
// the 200 matches, the 201st occurrence is returned unchanged. A parse failure
// (unknown extension syntax, bad timezone) drops to the interval schedule.

// normalizeCronSchedule is normalizeCronSchedule.
func normalizeCronSchedule(source *source) *cronSchedule {
	config, ok := decodeObject(source.Config)
	if !ok {
		return nil
	}
	schedule, ok := config.objectField("schedule")
	if !ok {
		return nil
	}
	modeRaw, _ := schedule.stringField("mode")
	if trimJS(modeRaw) == "" || lowerTrim(modeRaw) != "cron" {
		return nil
	}
	cron, ok := schedule.objectField("cron")
	if !ok {
		return nil
	}
	expressionRaw, _ := cron.stringField("expression")
	expression := trimJS(expressionRaw)
	if expression == "" {
		return nil
	}
	timezoneRaw, _ := cron.stringField("timezone")
	timezone := trimJS(timezoneRaw)
	var timezonePtr *string
	if timezone != "" {
		value := timezone
		timezonePtr = &value
	}

	windowObject, hasWindow := schedule.objectField("window")
	var window *cronWindow
	if hasWindow {
		daysOfWeek := []int{}
		if values, ok := windowObject.arrayField("daysOfWeek"); ok {
			for _, entry := range values {
				var number float64
				if err := json.Unmarshal(entry, &number); err != nil {
					continue
				}
				if math.IsNaN(number) || math.IsInf(number, 0) {
					continue
				}
				day := int(math.Floor(number))
				if day < 0 || day > 6 {
					continue
				}
				daysOfWeek = append(daysOfWeek, day)
			}
		}
		var startHour *int
		if value, ok := windowObject.numberField("startHour"); ok {
			hour := int(math.Max(0, math.Min(23, math.Floor(value))))
			startHour = &hour
		}
		var endHour *int
		if value, ok := windowObject.numberField("endHour"); ok {
			hour := int(math.Max(1, math.Min(24, math.Floor(value))))
			endHour = &hour
		}
		if len(daysOfWeek) > 0 || startHour != nil || endHour != nil {
			window = &cronWindow{
				DaysOfWeek: dedupeInts(daysOfWeek),
				StartHour:  startHour,
				EndHour:    endHour,
			}
		}
	}

	return &cronSchedule{
		Expression: expression,
		Timezone:   timezonePtr,
		Window:     window,
	}
}

// dedupeInts is Array.from(new Set(values)).
func dedupeInts(values []int) []int {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[int]bool, len(values))
	out := make([]int, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// zonedWeekdayAndHour is getZonedWeekdayAndHour. A zone that cannot be resolved
// yields ok=false, which makes the window match everything (the NestJS catch
// branch).
func zonedWeekdayAndHour(value time.Time, timezone string) (int, int, bool) {
	if timezone == "" {
		timezone = "UTC"
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return 0, 0, false
	}
	zoned := value.In(location)
	return int(zoned.Weekday()), zoned.Hour(), true
}

// isWithinCronWindow is isWithinCronWindow.
func isWithinCronWindow(value time.Time, window *cronWindow, timezone string) bool {
	if window == nil {
		return true
	}
	weekday, hour, ok := zonedWeekdayAndHour(value, timezone)
	if !ok {
		return true
	}
	if len(window.DaysOfWeek) > 0 && !containsInt(window.DaysOfWeek, weekday) {
		return false
	}
	if window.StartHour != nil && window.EndHour != nil {
		if *window.StartHour < *window.EndHour {
			if hour < *window.StartHour || hour >= *window.EndHour {
				return false
			}
		}
	}
	return true
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// computeNextRunAt is computeNextRunAt. intervalSecondsOverride is the RSS
// adaptive interval, nil for every other caller.
func (s *Service) computeNextRunAt(source *source, scheduledFor, now time.Time, intervalSecondsOverride *int) time.Time {
	cron := normalizeCronSchedule(source)
	if cron != nil {
		base := scheduledFor
		if now.After(base) {
			base = now
		}
		timezone := "UTC"
		if cron.Timezone != nil {
			timezone = *cron.Timezone
		}
		location, err := time.LoadLocation(timezone)
		if err == nil {
			expression, parseErr := parseCronExpression(cron.Expression, location)
			if parseErr == nil {
				cursor := base
				for iteration := 0; iteration < minCronIterationsBeforeWindowFallback; iteration++ {
					next, nextErr := expression.Next(cursor)
					if nextErr != nil {
						s.logWarn("failed to compute cron nextRunAt; falling back to interval schedule",
							"sourceId", source.ID, "orgId", source.OrgID, "error", nextErr)
						parseErr = nextErr
						break
					}
					if isWithinCronWindow(next, cron.Window, timezone) {
						return next
					}
					cursor = next
				}
				if parseErr == nil {
					next, nextErr := expression.Next(cursor)
					if nextErr == nil {
						return next
					}
					s.logWarn("failed to compute cron nextRunAt; falling back to interval schedule",
						"sourceId", source.ID, "orgId", source.OrgID, "error", nextErr)
				}
			} else {
				s.logWarn("failed to compute cron nextRunAt; falling back to interval schedule",
					"sourceId", source.ID, "orgId", source.OrgID, "error", parseErr)
			}
		} else {
			s.logWarn("failed to compute cron nextRunAt; falling back to interval schedule",
				"sourceId", source.ID, "orgId", source.OrgID, "error", err)
		}
	}

	frequency := source.FrequencySeconds
	if intervalSecondsOverride != nil {
		frequency = *intervalSecondsOverride
	}
	return s.computeNextIntervalRunAt(frequency, scheduledFor, now)
}

// computeNextIntervalRunAt is computeNextIntervalRunAt.
func (s *Service) computeNextIntervalRunAt(frequencySeconds int, scheduledFor, now time.Time) time.Time {
	seconds := 0
	if frequencySeconds > 0 {
		seconds = frequencySeconds
	}
	anchor := scheduledFor
	if now.After(anchor) {
		anchor = now
	}
	baseMs := anchor.UnixMilli() + int64(seconds)*1000

	jitterMaxMs := s.settings.JitterMax.Milliseconds()
	if jitterMaxMs < 0 {
		jitterMaxMs = 0
	}
	if jitterMaxMs <= 0 || seconds == 0 {
		return time.UnixMilli(baseMs).UTC()
	}
	capped := jitterMaxMs
	if int64(seconds)*1000 < capped {
		capped = int64(seconds) * 1000
	}
	jitter := int64(0)
	if capped > 0 {
		// Math.floor(Math.random() * (capped + 1))
		jitter = int64(s.randomFloat() * float64(capped+1))
	}
	return time.UnixMilli(baseMs + jitter).UTC()
}

// computeExponentialBackoffDelay is computeExponentialBackoffDelay:
// min(base * 2^(attempt-1), max) scaled by 0.75 + random * 0.5 and rounded.
func (s *Service) computeExponentialBackoffDelay(baseDelayMs, attempt, maxDelayMs int64) int64 {
	normalizedAttempt := attempt
	if normalizedAttempt < 1 {
		normalizedAttempt = 1
	}
	normalizedBase := baseDelayMs
	if normalizedBase < 1 {
		normalizedBase = 1
	}
	normalizedMax := maxDelayMs
	if normalizedMax < normalizedBase {
		normalizedMax = normalizedBase
	}
	exponent := normalizedAttempt - 1
	if exponent < 0 {
		exponent = 0
	}
	exponential := float64(normalizedBase) * math.Pow(2, float64(exponent))
	capped := math.Min(exponential, float64(normalizedMax))
	jitterFactor := 0.75 + s.randomFloat()*0.5
	return int64(jsRound(capped * jitterFactor))
}
