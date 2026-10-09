package dashboardstats

import (
	"math"
	"strconv"
	"strings"
)

// trackedStatuses 与 QueueOrgStatsService.TRACKED_STATUSES 顺序一致。
// HMGET 按下标取回，缺失下标归零。
var trackedStatuses = [5]string{"waiting", "active", "completed", "failed", "delayed"}

const itemPipelineQueue = "itemPipeline"

// countsKey 是 NestJS QueueOrgStatsService.countsKey 的同一 Redis hash。
// 只读。不写计数，不碰 BullMQ 的 job key。
func countsKey(orgID string) string {
	return "queue:" + itemPipelineQueue + ":org:" + orgID + ":counts"
}

// queueCounts 是响应里的 queue 对象。字段顺序即 JSON 键顺序。
type queueCounts struct {
	Waiting   float64 `json:"waiting"`
	Active    float64 `json:"active"`
	Completed float64 `json:"completed"`
	Failed    float64 `json:"failed"`
	Delayed   float64 `json:"delayed"`
}

func zeroQueue() queueCounts { return queueCounts{} }

// countsFromValues 复刻 getCounts + getOrgJobCounts：
// Redis 命令失败 → available=false，五个计数归零（请求仍可成功）；
// 命令成功但字段缺失、空串、非有限数或负数 → 该字段为 0，available 仍为 true。
// 缺 key 时 HMGET 返回五个 nil，这是成功，不是故障。
func countsFromValues(vals []any, err error) (queueCounts, bool) {
	if err != nil {
		return zeroQueue(), false
	}
	return queueCounts{
		Waiting:   parseRedisCount(valueAt(vals, 0)),
		Active:    parseRedisCount(valueAt(vals, 1)),
		Completed: parseRedisCount(valueAt(vals, 2)),
		Failed:    parseRedisCount(valueAt(vals, 3)),
		Delayed:   parseRedisCount(valueAt(vals, 4)),
	}, true
}

func valueAt(vals []any, index int) any {
	if index < 0 || index >= len(vals) {
		return nil
	}
	return vals[index]
}

// parseRedisCount 对齐 `value ? Number(value) : 0`，再
// `Number.isFinite(num) ? Math.max(0, num) : 0`。
// 空串与 nil 在 Number() 之前就归零。空白串是 truthy，Number(" ") 为 0。
func parseRedisCount(value any) float64 {
	if value == nil {
		return 0
	}
	var raw string
	switch typed := value.(type) {
	case string:
		raw = typed
	case []byte:
		raw = string(typed)
	default:
		return 0
	}
	if raw == "" {
		return 0
	}
	number, ok := jsNumber(raw)
	if !ok || number < 0 {
		return 0
	}
	return number
}

// jsNumber 对齐 JavaScript Number(string) 里计数会遇到的子集：
// 去空白、拒绝尾部垃圾、十六进制、Infinity/NaN 视为无效。
func jsNumber(raw string) (float64, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return 0, true
	}
	if len(text) > 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X') {
		parsed, err := strconv.ParseInt(text, 0, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}
