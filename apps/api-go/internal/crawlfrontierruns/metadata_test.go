package crawlfrontierruns

import (
	"encoding/json"
	"reflect"
	"testing"
)

// decodeMetadata builds the typed metadata view from raw JSON.
func decodeMetadata(raw string) runMetadataView {
	return decodeRunMetadata(RawJSON(raw))
}

func TestCollectNodeWarningFlags(t *testing.T) {
	cases := []struct {
		name      string
		metadata  string
		lastError *string
		want      []string
	}{
		{
			name:     "metadata flags are trimmed and deduplicated",
			metadata: `{"warningFlags":[" a ","","b","a"],"failureKind":"challenge_detected"}`,
			want:     []string{"a", "b", "challenge_detected"},
		},
		{
			name:      "ssrf keyword",
			metadata:  `{}`,
			lastError: stringPointer("SSRF protection blocked the target"),
			want:      []string{"ssrf_blocked"},
		},
		{
			name:      "challenge keyword",
			metadata:  `{}`,
			lastError: stringPointer("Cloudflare challenge detected"),
			want:      []string{"challenge_detected"},
		},
		{
			name:      "network keyword",
			metadata:  `{}`,
			lastError: stringPointer("read ECONNRESET"),
			want:      []string{"network_tunnel_error"},
		},
		{
			name:      "metadata failure kind wins over lastError",
			metadata:  `{"failureKind":"custom_kind"}`,
			lastError: stringPointer("ECONNRESET"),
			want:      []string{"custom_kind"},
		},
		{
			name:      "blank metadata failure kind falls back",
			metadata:  `{"failureKind":"   "}`,
			lastError: stringPointer("navigation timeout"),
			want:      []string{"network_tunnel_error"},
		},
		{
			name:     "llm judge parse failure",
			metadata: `{"llmJudgeEnabled":true,"llmJudgeAttempted":true,"llmJudgeParsed":false}`,
			want:     []string{"llm_judge_parse_failed"},
		},
		{
			name:     "llm judge error",
			metadata: `{"llmJudgeEnabled":true,"llmJudgeAttempted":true,"llmJudgeError":"boom"}`,
			want:     []string{"llm_judge_failed"},
		},
		{
			name:     "non boolean judge flags are ignored",
			metadata: `{"llmJudgeEnabled":"true","llmJudgeAttempted":1,"llmJudgeParsed":0}`,
			want:     []string{},
		},
		{
			name:     "no signals",
			metadata: `{}`,
			want:     []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			metadata := decodeMetadata(tc.metadata)
			got := collectNodeWarningFlags(&metadata, tc.lastError)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("warningFlags = %v, want %v", got, tc.want)
			}
		})
	}
}

// stringPointer returns a pointer to a literal.
func stringPointer(value string) *string {
	return &value
}

func TestMatchesRunQueryFilters(t *testing.T) {
	base := runListItem{runFields: runFields{
		ExecutionMode: ExecutionModeLayered,
		Metadata:      RawJSON(`{"runRole":"active","failureKind":"captcha","warningFlags":["ssrf_blocked"],"seedStrategy":"auto","rootDiagnosis":{"failureKind":"root_kind","seedStrategy":"frontier_only"}}`),
	}}
	cases := []struct {
		name  string
		query listQuery
		item  runListItem
		want  bool
	}{
		{name: "no filters", query: listQuery{}, item: base, want: true},
		{name: "execution mode match", query: listQuery{ExecutionMode: stringPointer("layered")}, item: base, want: true},
		{name: "execution mode mismatch", query: listQuery{ExecutionMode: stringPointer("native")}, item: base, want: false},
		{name: "run role match", query: listQuery{RunRole: stringPointer("active")}, item: base, want: true},
		{name: "run role mismatch", query: listQuery{RunRole: stringPointer("shadow")}, item: base, want: false},
		{name: "failure kind match", query: listQuery{FailureKind: stringPointer("captcha")}, item: base, want: true},
		{name: "warning flag match", query: listQuery{WarningFlag: stringPointer("ssrf_blocked")}, item: base, want: true},
		{name: "warning flag mismatch", query: listQuery{WarningFlag: stringPointer("llm_judge_failed")}, item: base, want: false},
		{name: "seed strategy match", query: listQuery{SeedStrategy: stringPointer("auto")}, item: base, want: true},
		{
			name:  "run role falls back to llm lifecycle",
			query: listQuery{RunRole: stringPointer("shadow")},
			item:  runListItem{runFields: runFields{ExecutionMode: ExecutionModeLayered, Metadata: RawJSON(`{"llmLifecycle":{"role":"shadow"}}`)}},
			want:  true,
		},
		{
			name:  "failure kind falls back to root diagnosis",
			query: listQuery{FailureKind: stringPointer("root_kind")},
			item:  runListItem{runFields: runFields{ExecutionMode: ExecutionModeLayered, Metadata: RawJSON(`{"rootDiagnosis":{"failureKind":"root_kind"}}`)}},
			want:  true,
		},
		{
			name:  "seed strategy falls back to root diagnosis",
			query: listQuery{SeedStrategy: stringPointer("frontier_only")},
			item:  runListItem{runFields: runFields{ExecutionMode: ExecutionModeLayered, Metadata: RawJSON(`{"rootDiagnosis":{"seedStrategy":"frontier_only"}}`)}},
			want:  true,
		},
		{
			name:  "missing metadata never matches a metadata filter",
			query: listQuery{RunRole: stringPointer("active")},
			item:  runListItem{runFields: runFields{ExecutionMode: ExecutionModeLayered}},
			want:  false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesRunQueryFilters(tc.item, tc.query); got != tc.want {
				t.Fatalf("matchesRunQueryFilters = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestToNumericRecord(t *testing.T) {
	record, ok := toNumericRecord(RawJSON(`{"a":"12","b":null,"c":"x","d":true,"e":[],"f":[5],"g":[1,2],"h":"0x10","i":3.5}`))
	if !ok {
		t.Fatal("expected a numeric record")
	}
	wantKeys := []string{"a", "b", "d", "e", "f", "h", "i"}
	wantValues := []float64{12, 0, 1, 0, 5, 16, 3.5}
	if !reflect.DeepEqual(record.Keys, wantKeys) || !reflect.DeepEqual(record.Values, wantValues) {
		t.Fatalf("record = %v / %v, want %v / %v", record.Keys, record.Values, wantKeys, wantValues)
	}

	if _, ok := toNumericRecord(RawJSON(`{}`)); ok {
		t.Fatal("empty object must report false")
	}
	if _, ok := toNumericRecord(RawJSON(`{"c":"x"}`)); ok {
		t.Fatal("object with no finite values must report false")
	}
	if _, ok := toNumericRecord(RawJSON(`[1,2]`)); ok {
		t.Fatal("array must report false")
	}
	if _, ok := toNumericRecord(nil); ok {
		t.Fatal("nil must report false")
	}
}

func TestOrderedCountsMarshalPreservesOrder(t *testing.T) {
	counts := orderedCounts{}
	counts.bump("second")
	counts.bump("first")
	counts.bump("second")
	encoded, err := json.Marshal(counts)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != `{"second":2,"first":1}` {
		t.Fatalf("encoded = %s", encoded)
	}
	empty, err := json.Marshal(orderedCounts{})
	if err != nil {
		t.Fatalf("marshal empty: %v", err)
	}
	if string(empty) != `{}` {
		t.Fatalf("empty counts = %s", empty)
	}
}
