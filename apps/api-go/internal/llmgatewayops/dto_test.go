package llmgatewayops

import (
	"strings"
	"testing"
)

// TestGovernanceUpdateOmittedVersusNull pins the three-way distinction the DTO
// and the service split between them: omitted inherits, an explicit null is
// Number(null) === 0, and an explicit value wins.
func TestGovernanceUpdateOmittedVersusNull(t *testing.T) {
	input, err := parseGovernanceUpdateInput([]byte(`{}`))
	if err != nil {
		t.Fatalf("empty body error = %v", err)
	}
	if input.DailyBudgetUSD.Present || input.MaxParallelRequests.Present || input.EnabledPresent || input.TargetProfileIDPresent {
		t.Fatalf("empty body must carry no explicit field: %+v", input)
	}
	if got := input.DailyBudgetUSD.budgetValue(25); got != 25 {
		t.Fatalf("omitted budget = %v, want the inherited 25", got)
	}
	if got := input.MaxParallelRequests.parallelValue(16); got != 16 {
		t.Fatalf("omitted concurrency = %d, want the inherited 16", got)
	}
	if got := input.enabledValue(true); !got {
		t.Fatal("omitted enabled must inherit true instead of turning governance off")
	}

	input, err = parseGovernanceUpdateInput([]byte(`{"dailyBudgetUsd":null,"monthlyBudgetUsd":null,"maxParallelRequests":null,"enabled":null,"targetProfileId":null}`))
	if err != nil {
		t.Fatalf("null body error = %v", err)
	}
	if !input.DailyBudgetUSD.Null || !input.MonthlyBudgetUSD.Null || !input.MaxParallelRequests.Null {
		t.Fatalf("explicit nulls must be recorded: %+v", input)
	}
	if got := input.DailyBudgetUSD.budgetValue(25); got != 0 {
		t.Fatalf("null budget = %v, want Number(null) = 0", got)
	}
	if got := input.MaxParallelRequests.parallelValue(16); got != 1 {
		t.Fatalf("null concurrency = %d, want the clamp of Number(null) = 1", got)
	}
	if !input.EnabledNull {
		t.Fatal("null enabled must be recorded as an explicit null")
	}
	if got := input.enabledValue(true); !got {
		t.Fatal("null enabled must inherit instead of becoming false")
	}
	if !input.TargetProfileIDPresent || input.TargetProfileID != nil {
		t.Fatalf("null targetProfileId must clear the selection: %+v", input)
	}

	input, err = parseGovernanceUpdateInput([]byte(`{"dailyBudgetUsd":"30.5","monthlyBudgetUsd":1000,"maxParallelRequests":"32","enabled":true,"targetProfileId":"p1"}`))
	if err != nil {
		t.Fatalf("value body error = %v", err)
	}
	// @Type(() => Number) coerces the two budget strings and the concurrency.
	if got := input.DailyBudgetUSD.budgetValue(25); got != 30.5 {
		t.Fatalf("coerced budget = %v, want 30.5", got)
	}
	if got := input.MaxParallelRequests.parallelValue(16); got != 32 {
		t.Fatalf("coerced concurrency = %d, want 32", got)
	}
	if input.TargetProfileID == nil || *input.TargetProfileID != "p1" {
		t.Fatalf("targetProfileId = %+v, want p1", input.TargetProfileID)
	}
}

// TestGovernanceUpdateValidationMessages pins the class-validator order: max,
// min, isInt.
func TestGovernanceUpdateValidationMessages(t *testing.T) {
	_, err := parseGovernanceUpdateInput([]byte(`{"dailyBudgetUsd":1000001,"maxParallelRequests":1025}`))
	if err == nil {
		t.Fatal("out-of-range budget must fail")
	}
	want := "dailyBudgetUsd must not be greater than 1000000; maxParallelRequests must not be greater than 1024"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}

	_, err = parseGovernanceUpdateInput([]byte(`{"maxParallelRequests":1.5}`))
	if err == nil || !strings.Contains(err.Error(), "must be an integer number") {
		t.Fatalf("fractional concurrency error = %v, want the isInt message", err)
	}

	_, err = parseGovernanceUpdateInput([]byte(`{"unknown":1}`))
	if err == nil || err.Error() != "property unknown should not exist" {
		t.Fatalf("unknown key error = %v", err)
	}

	_, err = parseGovernanceUpdateInput([]byte(`[]`))
	if err == nil || err.Error() != "an unknown value was passed to the validate function" {
		t.Fatalf("non-object body error = %v", err)
	}
}

// TestTestInputDefaultsAndCaps pins the saved-test DTO limits and the null
// behaviour of the boolean switches.
func TestTestInputDefaultsAndCaps(t *testing.T) {
	input, err := parseTestInput([]byte(`{}`))
	if err != nil {
		t.Fatalf("empty body error = %v", err)
	}
	if input.IncludeCompletion != nil || input.IncludeEmbeddings != nil || input.IncludeRerank != nil {
		t.Fatalf("omitted switches must stay nil: %+v", input)
	}

	input, err = parseTestInput([]byte(`{"includeCompletion":null,"authMode":"managed_runtime_key"}`))
	if err != nil {
		t.Fatalf("null switch error = %v", err)
	}
	if input.IncludeCompletion != nil {
		t.Fatal("null includeCompletion must behave like omitted")
	}
	if input.AuthMode == nil || *input.AuthMode != authModeManagedKey {
		t.Fatalf("authMode = %+v", input.AuthMode)
	}

	tooMany := `{"rerankDocuments":[` + strings.Repeat(`"d",`, 20) + `"d"]}`
	if _, err := parseTestInput([]byte(tooMany)); err == nil || !strings.Contains(err.Error(), "must contain no more than 20 elements") {
		t.Fatalf("21 documents error = %v", err)
	}

	longPrompt := `{"prompt":"` + strings.Repeat("x", maxInputLength+1) + `"}`
	if _, err := parseTestInput([]byte(longPrompt)); err == nil ||
		!strings.Contains(err.Error(), "prompt must be shorter than or equal to 4000 characters") {
		t.Fatalf("long prompt error = %v", err)
	}

	if _, err := parseTestInput([]byte(`{"apiSurface":"responses"}`)); err != nil {
		t.Fatalf("responses surface error = %v", err)
	}
	if _, err := parseTestInput([]byte(`{"apiSurface":"completions"}`)); err == nil {
		t.Fatal("an unknown apiSurface must fail")
	}
}

// TestConfigInputApiKeyAndTimeout pins the apiKey tri-state and the integer-only
// timeout of the ad-hoc DTOs.
func TestConfigInputApiKeyAndTimeout(t *testing.T) {
	input, err := parseModelsConfigInput([]byte(`{"apiBase":"http://litellm:4000"}`))
	if err != nil {
		t.Fatalf("minimal body error = %v", err)
	}
	if input.APIKeySet || input.TimeoutMS != nil {
		t.Fatalf("omitted apiKey/timeoutMs must stay unset: %+v", input)
	}

	input, err = parseModelsConfigInput([]byte(`{"apiBase":"http://litellm:4000","apiKey":null,"timeoutMs":null}`))
	if err != nil {
		t.Fatalf("null body error = %v", err)
	}
	if input.APIKeySet {
		t.Fatal("null apiKey must reuse the stored key instead of clearing it")
	}
	if input.TimeoutMS != nil {
		t.Fatal("null timeoutMs must inherit the stored timeout")
	}

	input, err = parseModelsConfigInput([]byte(`{"apiBase":"http://litellm:4000","apiKey":"  Bearer sk-abc  "}`))
	if err != nil {
		t.Fatalf("bearer body error = %v", err)
	}
	if !input.APIKeySet || input.APIKey != "sk-abc" {
		t.Fatalf("apiKey = %q set=%v, want the normalized sk-abc", input.APIKey, input.APIKeySet)
	}

	input, err = parseModelsConfigInput([]byte(`{"apiBase":"http://litellm:4000","apiKey":""}`))
	if err != nil {
		t.Fatalf("empty key body error = %v", err)
	}
	if !input.APIKeySet || input.APIKey != "" {
		t.Fatal("an explicit empty string must CLEAR the stored key")
	}

	// timeoutMs has no @Type, so a string is a validation error.
	if _, err := parseModelsConfigInput([]byte(`{"apiBase":"http://litellm:4000","timeoutMs":"5000"}`)); err == nil {
		t.Fatal("a string timeoutMs must fail validation")
	}
	if _, err := parseModelsConfigInput([]byte(`{"apiBase":"litellm:4000"}`)); err == nil {
		t.Fatal("a protocol-less apiBase must fail validation")
	}
	if _, err := parseModelsConfigInput([]byte(`{}`)); err == nil ||
		!strings.Contains(err.Error(), "apiBase must be a URL address") {
		t.Fatalf("missing apiBase error = %v", err)
	}
}

// TestTestConfigInputDoesNotCapPrompt pins that the ad-hoc DTO keeps the
// unlimited prompt the source allows.
func TestTestConfigInputDoesNotCapPrompt(t *testing.T) {
	longPrompt := strings.Repeat("x", maxInputLength+500)
	body := `{"apiBase":"http://litellm:4000","model":"gpt","prompt":"` + longPrompt + `"}`
	input, err := parseTestConfigInput([]byte(body))
	if err != nil {
		t.Fatalf("long prompt error = %v", err)
	}
	if input.Prompt == nil || len(*input.Prompt) != len(longPrompt) {
		t.Fatal("the test-config prompt must not be capped at 4000 characters")
	}
	// The same body must fail on the saved-test DTO.
	if _, err := parseTestInput([]byte(`{"prompt":"` + longPrompt + `"}`)); err == nil {
		t.Fatal("the saved-test prompt must stay capped")
	}
}

// TestLBTestInputDefaults pins the attempt/concurrency defaults and the null
// clamp.
func TestLBTestInputDefaults(t *testing.T) {
	input, err := parseLBTestInput([]byte(`{}`))
	if err != nil {
		t.Fatalf("empty body error = %v", err)
	}
	if got := input.Attempts.clampedInt(minLBAttempts, maxLBAttempts, defaultLBAttempts); got != 8 {
		t.Fatalf("omitted attempts = %d, want 8", got)
	}
	if got := input.Concurrency.clampedInt(minLBConcurrency, maxLBConcurrency, defaultLBConcurrency); got != 2 {
		t.Fatalf("omitted concurrency = %d, want 2", got)
	}

	input, err = parseLBTestInput([]byte(`{"attempts":null,"concurrency":null}`))
	if err != nil {
		t.Fatalf("null body error = %v", err)
	}
	if got := input.Attempts.clampedInt(minLBAttempts, maxLBAttempts, defaultLBAttempts); got != 1 {
		t.Fatalf("null attempts = %d, want the clamp of Number(null)", got)
	}

	if _, err := parseLBTestInput([]byte(`{"attempts":51}`)); err == nil {
		t.Fatal("attempts above 50 must fail")
	}
	if _, err := parseLBTestInput([]byte(`{"concurrency":0}`)); err == nil {
		t.Fatal("concurrency below 1 must fail")
	}
}

// TestGovernanceTargetProfileIsTrimmed pins the service normalization
// `normalizeOptionalString(value) ?? null`: a padded id is trimmed and a blank
// one clears the selection instead of being persisted as "".
func TestGovernanceTargetProfileIsTrimmed(t *testing.T) {
	input, err := parseGovernanceUpdateInput([]byte(`{"targetProfileId":"  p1  "}`))
	if err != nil {
		t.Fatalf("padded body error = %v", err)
	}
	if input.TargetProfileID == nil || *input.TargetProfileID != "p1" {
		t.Fatalf("targetProfileId = %v, want the trimmed p1", input.TargetProfileID)
	}

	blank, err := parseGovernanceUpdateInput([]byte(`{"targetProfileId":"   "}`))
	if err != nil {
		t.Fatalf("blank body error = %v", err)
	}
	if !blank.TargetProfileIDPresent || blank.TargetProfileID != nil {
		t.Fatalf("blank targetProfileId = %+v, want a cleared selection", blank)
	}

	preflight, err := parseGovernancePreflightInput([]byte(`{"targetProfileId":""}`))
	if err != nil {
		t.Fatalf("preflight body error = %v", err)
	}
	if !preflight.TargetProfileIDPresent || preflight.TargetProfileID != nil {
		t.Fatalf("preflight targetProfileId = %+v, want a cleared selection", preflight)
	}
}

// TestRerankDocumentsMessagesMatchClassValidator pins the `each` fallback: when the
// value is not an array class-validator validates the value itself, so the each
// messages still appear before ArrayMaxSize, and a non-string element fails both
// each constraints.
func TestRerankDocumentsMessagesMatchClassValidator(t *testing.T) {
	_, err := parseTestInput([]byte(`{"rerankDocuments":"abc"}`))
	wantNonArray := "rerankDocuments must contain no more than 20 elements; rerankDocuments must be an array"
	if err == nil || err.Error() != wantNonArray {
		t.Fatalf("non-array error = %v, want %q", err, wantNonArray)
	}

	_, err = parseTestInput([]byte(`{"rerankDocuments":[null]}`))
	wantElement := "each value in rerankDocuments must be shorter than or equal to 4000 characters; each value in rerankDocuments must be a string"
	if err == nil || err.Error() != wantElement {
		t.Fatalf("non-string element error = %v, want %q", err, wantElement)
	}
}
