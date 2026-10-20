package alertworker

import "testing"

// TestRenderAlertHTMLSnapshots pins the full alert.hbs output. The expected
// strings are byte-level snapshots copied from the Handlebars result of
// apps/api/src/modules/email/templates/alert.hbs.
func TestRenderAlertHTMLSnapshots(t *testing.T) {
	zeroThreshold := 0.0
	message := "磁盘使用率超过 90%"
	changePercent := 12.5

	cases := []struct {
		name  string
		input AlertEmailInput
		want  string
	}{
		{
			name: "no message no change no threshold",
			input: AlertEmailInput{
				RuleName:    "CPU 高负载",
				Metric:      "cpu_usage",
				Value:       95.5,
				TriggeredAt: "2026-10-20T00:00:00.000Z",
			},
			want: "<h3>告警触发：CPU 高负载</h3>\n" +
				"<p>指标：cpu_usage</p>\n" +
				"<p>当前值：95.5</p>\n" +
				"<p>阈值：未设置</p>\n" +
				"<p>时间：2026-10-20T00:00:00.000Z</p>\n",
		},
		{
			name: "message change and zero threshold",
			input: AlertEmailInput{
				RuleName:      "磁盘使用率",
				Metric:        "disk_usage_percent",
				Value:         91.25,
				Threshold:     &zeroThreshold,
				TriggeredAt:   "2026-10-20T01:02:03.456Z",
				Message:       &message,
				ChangePercent: &changePercent,
			},
			want: "<h3>告警触发：磁盘使用率</h3>\n" +
				"<p>指标：disk_usage_percent</p>\n" +
				"<p>当前值：91.25（变化：12.50%）</p>\n" +
				"<p>阈值：0</p>\n" +
				"<p>时间：2026-10-20T01:02:03.456Z</p>\n" +
				"<p>详情：磁盘使用率超过 90%</p>\n",
		},
		{
			name: "escaping and number formatting",
			input: AlertEmailInput{
				RuleName:      "a\"b<c&d'e`f=g",
				Metric:        "m>n",
				Value:         0.30000000000000004,
				Threshold:     alertEmailFloat64Pointer(1234.5678),
				TriggeredAt:   "2026-10-20T02:03:04.567Z",
				Message:       alertEmailStringPointer("x&y"),
				ChangePercent: alertEmailFloat64Pointer(-0.125),
			},
			want: "<h3>告警触发：a&quot;b&lt;c&amp;d&#x27;e&#x60;f&#x3D;g</h3>\n" +
				"<p>指标：m&gt;n</p>\n" +
				"<p>当前值：0.30000000000000004（变化：-0.13%）</p>\n" +
				"<p>阈值：1234.5678</p>\n" +
				"<p>时间：2026-10-20T02:03:04.567Z</p>\n" +
				"<p>详情：x&amp;y</p>\n",
		},
		{
			name: "zero change percent is truthy",
			input: AlertEmailInput{
				RuleName:      "零变化",
				Metric:        "latency_ms",
				Value:         1e21,
				TriggeredAt:   "2026-10-20T03:04:05.678Z",
				ChangePercent: alertEmailFloat64Pointer(0),
			},
			want: "<h3>告警触发：零变化</h3>\n" +
				"<p>指标：latency_ms</p>\n" +
				"<p>当前值：1e+21（变化：0.00%）</p>\n" +
				"<p>阈值：未设置</p>\n" +
				"<p>时间：2026-10-20T03:04:05.678Z</p>\n",
		},
		{
			name: "one percent renders two decimals",
			input: AlertEmailInput{
				RuleName:      "百分之一",
				Metric:        "error_rate",
				Value:         2.5,
				TriggeredAt:   "2026-10-20T03:04:06.789Z",
				ChangePercent: alertEmailFloat64Pointer(1),
			},
			want: "<h3>告警触发：百分之一</h3>\n" +
				"<p>指标：error_rate</p>\n" +
				"<p>当前值：2.5（变化：1.00%）</p>\n" +
				"<p>阈值：未设置</p>\n" +
				"<p>时间：2026-10-20T03:04:06.789Z</p>\n",
		},
		{
			name: "empty message is falsy",
			input: AlertEmailInput{
				RuleName:    "空详情",
				Metric:      "error_rate",
				Value:       0,
				TriggeredAt: "2026-10-20T04:05:06.789Z",
				Message:     alertEmailStringPointer(""),
			},
			want: "<h3>告警触发：空详情</h3>\n" +
				"<p>指标：error_rate</p>\n" +
				"<p>当前值：0</p>\n" +
				"<p>阈值：未设置</p>\n" +
				"<p>时间：2026-10-20T04:05:06.789Z</p>\n",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := RenderAlertHTML(testCase.input); got != testCase.want {
				t.Fatalf("RenderAlertHTML() = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestRenderAlertTextSnapshots pins the full alert.text.hbs output. The text
// template is compiled with Handlebars too, so it escapes as well.
func TestRenderAlertTextSnapshots(t *testing.T) {
	zeroThreshold := 0.0
	message := "磁盘使用率超过 90%"
	changePercent := 12.5

	cases := []struct {
		name  string
		input AlertEmailInput
		want  string
	}{
		{
			name: "no message no change no threshold",
			input: AlertEmailInput{
				RuleName:    "CPU 高负载",
				Metric:      "cpu_usage",
				Value:       95.5,
				TriggeredAt: "2026-10-20T00:00:00.000Z",
			},
			want: "告警触发：CPU 高负载\n" +
				"指标：cpu_usage\n" +
				"当前值：95.5\n" +
				"阈值：未设置\n" +
				"时间：2026-10-20T00:00:00.000Z\n",
		},
		{
			name: "message change and zero threshold",
			input: AlertEmailInput{
				RuleName:      "磁盘使用率",
				Metric:        "disk_usage_percent",
				Value:         91.25,
				Threshold:     &zeroThreshold,
				TriggeredAt:   "2026-10-20T01:02:03.456Z",
				Message:       &message,
				ChangePercent: &changePercent,
			},
			want: "告警触发：磁盘使用率\n" +
				"指标：disk_usage_percent\n" +
				"当前值：91.25（变化：12.50%）\n" +
				"阈值：0\n" +
				"时间：2026-10-20T01:02:03.456Z\n" +
				"详情：磁盘使用率超过 90%\n",
		},
		{
			name: "escaping and number formatting",
			input: AlertEmailInput{
				RuleName:      "a\"b<c&d'e`f=g",
				Metric:        "m>n",
				Value:         0.30000000000000004,
				Threshold:     alertEmailFloat64Pointer(1234.5678),
				TriggeredAt:   "2026-10-20T02:03:04.567Z",
				Message:       alertEmailStringPointer("x&y"),
				ChangePercent: alertEmailFloat64Pointer(-0.125),
			},
			want: "告警触发：a&quot;b&lt;c&amp;d&#x27;e&#x60;f&#x3D;g\n" +
				"指标：m&gt;n\n" +
				"当前值：0.30000000000000004（变化：-0.13%）\n" +
				"阈值：1234.5678\n" +
				"时间：2026-10-20T02:03:04.567Z\n" +
				"详情：x&amp;y\n",
		},
		{
			name: "zero change percent is truthy",
			input: AlertEmailInput{
				RuleName:      "零变化",
				Metric:        "latency_ms",
				Value:         1e21,
				TriggeredAt:   "2026-10-20T03:04:05.678Z",
				ChangePercent: alertEmailFloat64Pointer(0),
			},
			want: "告警触发：零变化\n" +
				"指标：latency_ms\n" +
				"当前值：1e+21（变化：0.00%）\n" +
				"阈值：未设置\n" +
				"时间：2026-10-20T03:04:05.678Z\n",
		},
		{
			name: "one percent renders two decimals",
			input: AlertEmailInput{
				RuleName:      "百分之一",
				Metric:        "error_rate",
				Value:         2.5,
				TriggeredAt:   "2026-10-20T03:04:06.789Z",
				ChangePercent: alertEmailFloat64Pointer(1),
			},
			want: "告警触发：百分之一\n" +
				"指标：error_rate\n" +
				"当前值：2.5（变化：1.00%）\n" +
				"阈值：未设置\n" +
				"时间：2026-10-20T03:04:06.789Z\n",
		},
		{
			name: "empty message is falsy",
			input: AlertEmailInput{
				RuleName:    "空详情",
				Metric:      "error_rate",
				Value:       0,
				TriggeredAt: "2026-10-20T04:05:06.789Z",
				Message:     alertEmailStringPointer(""),
			},
			want: "告警触发：空详情\n" +
				"指标：error_rate\n" +
				"当前值：0\n" +
				"阈值：未设置\n" +
				"时间：2026-10-20T04:05:06.789Z\n",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := RenderAlertText(testCase.input); got != testCase.want {
				t.Fatalf("RenderAlertText() = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestAlertEmailSubject pins the NestJS subject template.
func TestAlertEmailSubject(t *testing.T) {
	if got, want := AlertEmailSubject("CPU 高负载"), "[Alert] CPU 高负载 triggered"; got != want {
		t.Fatalf("AlertEmailSubject() = %q, want %q", got, want)
	}
	// The subject is built outside Handlebars, so it is not HTML-escaped.
	if got, want := AlertEmailSubject(`a"b<c`), `[Alert] a"b<c triggered`; got != want {
		t.Fatalf("AlertEmailSubject() = %q, want %q", got, want)
	}
}

// alertEmailStringPointer and alertEmailFloat64Pointer build the nullable template inputs.
func alertEmailStringPointer(value string) *string {
	return &value
}

func alertEmailFloat64Pointer(value float64) *float64 {
	return &value
}
