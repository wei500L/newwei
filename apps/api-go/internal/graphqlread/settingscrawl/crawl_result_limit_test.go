package settingscrawl

import (
	"net/http"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TestCrawlTaskResultLimitArg pins the @Min(1) semantics of the crawlTask
// argument: absent falls back to 20, a present value below 1 is a BAD_REQUEST
// field error, and a value above 100 is left for the resolver's clamp.
func TestCrawlTaskResultLimitArg(t *testing.T) {
	cases := []struct {
		name  string
		args  map[string]any
		want  int
		wantE string
	}{
		{name: "absent uses the default", args: map[string]any{}, want: 20},
		{name: "explicit null uses the default", args: map[string]any{"resultLimit": nil}, want: 20},
		{name: "one is allowed", args: map[string]any{"resultLimit": float64(1)}, want: 1},
		{name: "above the clamp stays", args: map[string]any{"resultLimit": float64(500)}, want: 500},
		{
			name:  "zero is rejected",
			args:  map[string]any{"resultLimit": float64(0)},
			wantE: "resultLimit must not be less than 1",
		},
		{
			name:  "negative is rejected",
			args:  map[string]any{"resultLimit": float64(-3)},
			wantE: "resultLimit must not be less than 1",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := crawlTaskResultLimitArg(testCase.args)
			if testCase.wantE != "" {
				if err == nil {
					t.Fatalf("expected %q, got limit %d", testCase.wantE, got)
				}
				failure, ok := err.(*contract.Failure)
				if !ok {
					t.Fatalf("expected *contract.Failure, got %T: %v", err, err)
				}
				if failure.Message != testCase.wantE {
					t.Fatalf("message = %q", failure.Message)
				}
				if failure.Status != http.StatusBadRequest {
					t.Fatalf("status = %d", failure.Status)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("limit = %d, want %d", got, testCase.want)
			}
		})
	}
}
