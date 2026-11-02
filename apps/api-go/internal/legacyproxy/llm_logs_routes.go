package legacyproxy

import "net/http"

// LlmLogsKey 是 LLM 请求日志三条只读 GET 的处理器注册键。三条都是精确
// 路径，键用集合路径本身（无动态段，不需要带尾斜杠）。
const LlmLogsKey = "/api/llm-logs"

// WithLlmLogs 只在 mode 为 go 时接管 LLM 请求日志的 3 条只读 GET：
//
//	GET /api/llm-logs（精确）
//	GET /api/llm-logs/export（精确）
//	GET /api/llm-logs/summary（精确）
//
// 三条都要求 settings.manage。其他方法（POST 等）与更长路径
// （/api/llm-logs/export/extra 等）不匹配精确规则，回落 /api/ 由 NestJS
// 处理（Go 不返回自己的 404）。
//
// /api/system-settings/llm-request-logs 不在这个开关里：那组设置会修改
// Mongo TTL 索引，始终留在 NestJS。Go 只从 MySQL SystemSetting 读
// llm_request_log_settings 算出列表响应里的 metadataPolicy。
func WithLlmLogs(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, LlmLogsKey, "/api/llm-logs", http.MethodGet)
	rules = appendExactKeyed(rules, LlmLogsKey, "/api/llm-logs/export", http.MethodGet)
	return appendExactKeyed(rules, LlmLogsKey, "/api/llm-logs/summary", http.MethodGet)
}
