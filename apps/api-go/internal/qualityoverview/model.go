package qualityoverview

// 响应形状按 NestJS 的接口与对象字面量逐字段对齐（结构体声明顺序即 JSON
// 键序；可空数值用指针，null 原样输出）。

// newsSourceQualitySummary 对齐 NewsSourceQualitySummary。
type newsSourceQualitySummary struct {
	WindowHours       int                `json:"windowHours"`
	Totals            newsSourceTotals   `json:"totals"`
	TopFailingSources []topFailingSource `json:"topFailingSources"`
}

type newsSourceTotals struct {
	Total       int `json:"total"`
	Active      int `json:"active"`
	Failing     int `json:"failing"`
	CircuitOpen int `json:"circuitOpen"`
}

type topFailingSource struct {
	SourceID            string  `json:"sourceId"`
	Name                string  `json:"name"`
	URL                 string  `json:"url"`
	FailedJobs          int     `json:"failedJobs"`
	ConsecutiveFailures int     `json:"consecutiveFailures"`
	LastFailureAt       *string `json:"lastFailureAt"`
	CircuitOpenUntil    *string `json:"circuitOpenUntil"`
	NextRunAt           *string `json:"nextRunAt"`
}

// pipelineQualitySummary 对齐 PipelineQualitySummary。
type pipelineQualitySummary struct {
	WindowMinutes      int                   `json:"windowMinutes"`
	Totals             pipelineTotals        `json:"totals"`
	SuccessRate        *float64              `json:"successRate"`
	AverageLatencyMs   *float64              `json:"averageLatencyMs"`
	IngestionLatencyMs ingestionLatency      `json:"ingestionLatencyMs"`
	FailureTypes       []pipelineFailureType `json:"failureTypes"`
	LlmModels          []pipelineLlmModel    `json:"llmModels"`
	Outbox             pipelineOutbox        `json:"outbox"`
}

type pipelineTotals struct {
	Total      int `json:"total"`
	Completed  int `json:"completed"`
	Failed     int `json:"failed"`
	Processing int `json:"processing"`
	Pending    int `json:"pending"`
}

type ingestionLatency struct {
	SampleSize int      `json:"sampleSize"`
	AverageMs  *float64 `json:"averageMs"`
	P50Ms      *float64 `json:"p50Ms"`
	P90Ms      *float64 `json:"p90Ms"`
	P99Ms      *float64 `json:"p99Ms"`
	MaxMs      *float64 `json:"maxMs"`
}

type pipelineFailureType struct {
	Stage     string `json:"stage"`
	ErrorName string `json:"errorName"`
	Count     int    `json:"count"`
}

type pipelineLlmModel struct {
	Model          string   `json:"model"`
	Count          int      `json:"count"`
	AvgLatencyMs   *float64 `json:"avgLatencyMs"`
	AvgCostUsd     *float64 `json:"avgCostUsd"`
	AvgTotalTokens *float64 `json:"avgTotalTokens"`
}

type pipelineOutbox struct {
	Totals           outboxTotals `json:"totals"`
	OldestCreatedAt  *string      `json:"oldestCreatedAt"`
	OldestAgeMinutes *float64     `json:"oldestAgeMinutes"`
}

type outboxTotals struct {
	Total           int `json:"total"`
	Pending         int `json:"pending"`
	Processing      int `json:"processing"`
	Failed          int `json:"failed"`
	Dead            int `json:"dead"`
	StaleProcessing int `json:"staleProcessing"`
}
