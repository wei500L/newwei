package newsbehavior

import (
	"regexp"
	"time"
)

const (
	// retentionV2Seconds 是日桶 EXPIRE。Nest 用 95 天，比 90 天窗口多五天。
	retentionV2Seconds = 95 * 24 * 60 * 60
	// profileCacheTTLSeconds 是画像 JSON 缓存。控制器没有 Cache-Control。
	profileCacheTTLSeconds = 30
	decayHalfLifeDays      = 90
	windowDays             = 90
	milestoneTTLSeconds    = 48 * 60 * 60
	dirtyThrottleSeconds   = 60

	legacyFallbackScale           = 0.18
	legacyFallbackActionThreshold = 2
	maxTermLength                 = 96
	maxIDLength                   = 128
	maxTermsPerDimension          = 8
	scoreLimit                    = 300
	scoreEpsilon                  = 0.0001
)

// dimensionNames 的顺序就是 Nest USER_NEWS_BEHAVIOR_DIMENSIONS，
// 也是旧版 hash kind 的删除顺序。
var dimensionNames = []string{
	"actions",
	"sources",
	"topics",
	"entities",
	"items",
	"events",
	"domains",
}

type behaviorBand struct {
	key        string
	start, end int
	weight     float64
}

var behaviorBands = []behaviorBand{
	{key: "1d", start: 0, end: 0},
	{key: "7d", start: 1, end: 6},
	{key: "30d", start: 7, end: 29},
	{key: "90d", start: 30, end: 89},
}

func legacyHashKey(orgID, userID, kind string) string {
	return "user-news-behavior:" + orgID + ":" + userID + ":" + kind
}

func dayBucketKey(orgID, userID, day string) string {
	return "user-news-behavior:v2:" + orgID + ":" + userID + ":day:" + day
}

func profileCacheKey(orgID, userID string) string {
	return "user-news-behavior:v2:" + orgID + ":" + userID + ":profile"
}

func milestoneKey(orgID, userID, eventType, day, id string) string {
	return "user-news-behavior:milestone:" + orgID + ":" + userID + ":" + eventType + ":" + day + ":" + id
}

func dirtyThrottleKey(orgID, userID string) string {
	return "user-news-behavior:sim-dirty:" + orgID + ":" + userID
}

func legacyHashKeys(orgID, userID string) []string {
	keys := make([]string, len(dimensionNames))
	for i, kind := range dimensionNames {
		keys[i] = legacyHashKey(orgID, userID, kind)
	}
	return keys
}

// recentDayKeys 从今天往回 90 个 UTC 日（含今天）。
// Date.UTC(y, m, d-offset) 的跨月进位与 time.Date 一致。
func recentDayKeys(orgID, userID string, now time.Time) []string {
	now = now.UTC()
	year, month, day := now.Date()
	keys := make([]string, windowDays)
	for offset := 0; offset < windowDays; offset++ {
		date := time.Date(year, month, day-offset, 0, 0, 0, 0, time.UTC)
		keys[offset] = dayBucketKey(orgID, userID, date.Format("20060102"))
	}
	return keys
}

func formatDayKey(t time.Time) string {
	return t.UTC().Format("20060102")
}

func behaviorFieldKey(polarity, dimension, term string) string {
	return polarity + ":" + dimension + ":" + term
}

// behaviorFieldRE 与 Nest parseBehaviorFieldKey 相同：term 吃掉剩余冒号。
// 没有 s 标志，换行不进 term。
var behaviorFieldRE = regexp.MustCompile(`^(p|n):(actions|sources|topics|entities|items|events|domains):(.+)$`)

type behaviorField struct {
	polarity  string
	dimension string
	term      string
}

func parseBehaviorField(field string) (behaviorField, bool) {
	match := behaviorFieldRE.FindStringSubmatch(field)
	if match == nil || match[3] == "" {
		return behaviorField{}, false
	}
	return behaviorField{polarity: match[1], dimension: match[2], term: match[3]}, true
}
