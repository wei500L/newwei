package llmgatewayops

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
)

// Governance defaults and limits. The budgets are the source defaults of an
// absent row; the limits are the same clamps the service applies on read and on
// write, so a hand-edited row degrades instead of failing.
const (
	defaultDailyBudgetUSD     = 25
	defaultMonthlyBudgetUSD   = 500
	defaultMaxParallelRequest = 16
	maxBudgetUSD              = 1_000_000
	minParallelRequests       = 1
	maxParallelRequests       = 1_024
)

// governanceSource reports where the effective settings came from.
type governanceSource string

const (
	// governanceSourceDefault means no stored document exists.
	governanceSourceDefault governanceSource = "default"
	// governanceSourceDB means a stored document exists.
	governanceSourceDB governanceSource = "db"
)

// managedKeyState is the three-way state of the stored managed runtime key.
// "unreadable" is distinct from "missing": a ciphertext that cannot be opened
// still counts as configured, so the console must not offer to create a new key
// as if none existed.
type managedKeyState string

const (
	// managedKeyMissing means no usable key is stored.
	managedKeyMissing managedKeyState = "missing"
	// managedKeyAvailable means the key is readable.
	managedKeyAvailable managedKeyState = "available"
	// managedKeyUnreadable means the envelope could not be decrypted.
	managedKeyUnreadable managedKeyState = "unreadable"
)

// rawGovernance is the tolerant decode boundary for the governance document.
// Every field is a raw JSON token so a legacy string number or a non-boolean
// enabled flag degrades through the same normalisation as NestJS instead of
// failing the whole document.
type rawGovernance struct {
	Enabled                json.RawMessage `json:"enabled"`
	DailyBudgetUSD         json.RawMessage `json:"dailyBudgetUsd"`
	MonthlyBudgetUSD       json.RawMessage `json:"monthlyBudgetUsd"`
	MaxParallelRequests    json.RawMessage `json:"maxParallelRequests"`
	TargetProfileID        json.RawMessage `json:"targetProfileId"`
	ManagedTeamID          json.RawMessage `json:"managedTeamId"`
	ManagedRuntimeKey      json.RawMessage `json:"managedRuntimeKey"`
	ManagedRuntimeKeyAlias json.RawMessage `json:"managedRuntimeKeyAlias"`
	LastSyncedAt           json.RawMessage `json:"lastSyncedAt"`
	LastSyncError          json.RawMessage `json:"lastSyncError"`
}

// storedGovernance is the document this batch writes. Field order matches the
// NestJS nextStored object literal so a rewritten document keeps the same key
// order.
type storedGovernance struct {
	Enabled                bool                            `json:"enabled"`
	DailyBudgetUSD         float64                         `json:"dailyBudgetUsd"`
	MonthlyBudgetUSD       float64                         `json:"monthlyBudgetUsd"`
	MaxParallelRequests    int                             `json:"maxParallelRequests"`
	TargetProfileID        *string                         `json:"targetProfileId"`
	ManagedTeamID          *string                         `json:"managedTeamId"`
	ManagedRuntimeKey      *llmgatewayprofiles.SecretValue `json:"managedRuntimeKey"`
	ManagedRuntimeKeyAlias *string                         `json:"managedRuntimeKeyAlias"`
	LastSyncedAt           *string                         `json:"lastSyncedAt"`
	LastSyncError          *string                         `json:"lastSyncError"`
}

// resolvedGovernance is the effective configuration after defaults, clamps and
// secret resolution.
type resolvedGovernance struct {
	Enabled                bool
	DailyBudgetUSD         float64
	MonthlyBudgetUSD       float64
	MaxParallelRequests    int
	TargetProfileID        *string
	ManagedTeamID          *string
	ManagedRuntimeKey      string
	ManagedRuntimeKeyState managedKeyState
	ManagedRuntimeKeyAlias *string
	LastSyncedAt           *string
	LastSyncError          *string
}

// trafficBindings reports which traffic kinds currently resolve to the selected
// target profile. Completion being bound does not imply embedding is.
type trafficBindings struct {
	Completion bool `json:"completion"`
	Embedding  bool `json:"embedding"`
	Rerank     bool `json:"rerank"`
}

// endpointCheck is one health probe result.
type endpointCheck struct {
	OK      bool    `json:"ok"`
	Status  *int    `json:"status,omitempty"`
	Message *string `json:"message,omitempty"`
}

// governanceHealthResult is the liveliness/readiness pair of one apiBase.
type governanceHealthResult struct {
	APIBase    string        `json:"apiBase"`
	CheckedAt  string        `json:"checkedAt"`
	Liveliness endpointCheck `json:"liveliness"`
	Readiness  endpointCheck `json:"readiness"`
}

// governanceCheck is one preflight gate.
type governanceCheck struct {
	Key      string `json:"key"`
	OK       bool   `json:"ok"`
	Required bool   `json:"required"`
	Message  string `json:"message"`
}

// governanceSettingsPublic is the projection returned by GET/PUT/DELETE and
// rotate. It never contains the managed runtime key or its ciphertext.
type governanceSettingsPublic struct {
	Source                 governanceSource `json:"source"`
	Enabled                bool             `json:"enabled"`
	APIBase                *string          `json:"apiBase"`
	DailyBudgetUSD         float64          `json:"dailyBudgetUsd"`
	MonthlyBudgetUSD       float64          `json:"monthlyBudgetUsd"`
	MaxParallelRequests    int              `json:"maxParallelRequests"`
	TargetProfileID        *string          `json:"targetProfileId"`
	TargetProfileName      *string          `json:"targetProfileName"`
	TargetProfileEnabled   bool             `json:"targetProfileEnabled"`
	AdminKeyConfigured     bool             `json:"adminKeyConfigured"`
	HasManagedRuntimeKey   bool             `json:"hasManagedRuntimeKey"`
	ManagedRuntimeKeyState managedKeyState  `json:"managedRuntimeKeyState"`
	ManagedTeamID          *string          `json:"managedTeamId"`
	ManagedRuntimeKeyAlias *string          `json:"managedRuntimeKeyAlias"`
	LastSyncedAt           *string          `json:"lastSyncedAt"`
	LastSyncError          *string          `json:"lastSyncError"`
}

// governancePreflightPublic is the enable-readiness report.
type governancePreflightPublic struct {
	TargetProfileID        *string                 `json:"targetProfileId"`
	TargetProfileName      *string                 `json:"targetProfileName"`
	APIBase                *string                 `json:"apiBase"`
	AdminKeyConfigured     bool                    `json:"adminKeyConfigured"`
	ManagedRuntimeKeyState managedKeyState         `json:"managedRuntimeKeyState"`
	TrafficBindings        trafficBindings         `json:"trafficBindings"`
	Health                 *governanceHealthResult `json:"health"`
	Checks                 []governanceCheck       `json:"checks"`
	CanEnable              bool                    `json:"canEnable"`
	BlockingIssues         []string                `json:"blockingIssues"`
	Warnings               []string                `json:"warnings"`
}

// governanceTargetProfile is the resolved target of a governance operation. A
// profile only counts as a target when it exists AND is enabled.
type governanceTargetProfile struct {
	ID      string
	Name    string
	APIBase string
}

// auditGovernanceUpdateMetadata is the audit payload of an enable/disable.
type auditGovernanceUpdateMetadata struct {
	Enabled                bool    `json:"enabled"`
	APIBase                *string `json:"apiBase"`
	DailyBudgetUSD         float64 `json:"dailyBudgetUsd"`
	MonthlyBudgetUSD       float64 `json:"monthlyBudgetUsd"`
	MaxParallelRequests    int     `json:"maxParallelRequests"`
	TargetProfileID        *string `json:"targetProfileId"`
	HasManagedRuntimeKey   bool    `json:"hasManagedRuntimeKey"`
	ManagedTeamID          *string `json:"managedTeamId"`
	ManagedRuntimeKeyAlias *string `json:"managedRuntimeKeyAlias"`
}

// auditGovernanceResetMetadata is the audit payload of a reset.
type auditGovernanceResetMetadata struct {
	OK              bool    `json:"ok"`
	APIBase         *string `json:"apiBase"`
	TargetProfileID *string `json:"targetProfileId"`
}

// auditGovernanceRotateMetadata is the audit payload of a rotate.
type auditGovernanceRotateMetadata struct {
	APIBase                *string `json:"apiBase"`
	TargetProfileID        *string `json:"targetProfileId"`
	ManagedTeamID          *string `json:"managedTeamId"`
	ManagedRuntimeKeyAlias *string `json:"managedRuntimeKeyAlias"`
}

// resolveGovernanceDocument converts the stored document into the effective
// configuration. A nil document means "no row", which is not the same as an
// empty object: both produce defaults, but only the row changes the reported
// source.
func (s *Service) resolveGovernanceDocument(raw json.RawMessage) resolvedGovernance {
	var fields rawGovernance
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &fields)
	}
	secret := decodeGovernanceSecret(fields.ManagedRuntimeKey)
	keyValue, keyState := s.resolveManagedRuntimeKey(secret)
	return resolvedGovernance{
		Enabled:                jsBoolean(fields.Enabled, false),
		DailyBudgetUSD:         budgetValue(fields.DailyBudgetUSD, defaultDailyBudgetUSD),
		MonthlyBudgetUSD:       budgetValue(fields.MonthlyBudgetUSD, defaultMonthlyBudgetUSD),
		MaxParallelRequests:    parallelValue(fields.MaxParallelRequests, defaultMaxParallelRequest),
		TargetProfileID:        optionalString(fields.TargetProfileID),
		ManagedTeamID:          optionalString(fields.ManagedTeamID),
		ManagedRuntimeKey:      keyValue,
		ManagedRuntimeKeyState: keyState,
		ManagedRuntimeKeyAlias: optionalString(fields.ManagedRuntimeKeyAlias),
		LastSyncedAt:           isoString(fields.LastSyncedAt),
		LastSyncError:          optionalString(fields.LastSyncError),
	}
}

// normalizeAPIBase is the shared normalizeOpenAiApiBase helper.
func normalizeAPIBase(raw string) string { return llmgatewayprofiles.NormalizeAPIBase(raw) }

// resolveManagedRuntimeKey mirrors the NestJS resolveSecret of the governance
// service: plaintext is trimmed but keeps its Bearer prefix (unlike the profile
// key helper), and a v1 envelope that cannot be opened is "unreadable" rather
// than "missing". secret is nil for an absent value.
func (s *Service) resolveManagedRuntimeKey(secret *llmgatewayprofiles.SecretValue) (string, managedKeyState) {
	if secret == nil {
		return "", managedKeyMissing
	}
	switch secret.Kind() {
	case llmgatewayprofiles.SecretPlaintext:
		value, ok := secret.Plaintext()
		if !ok {
			return "", managedKeyMissing
		}
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return "", managedKeyMissing
		}
		return trimmed, managedKeyAvailable
	case llmgatewayprofiles.SecretEncrypted:
		envelope, ok := secret.Envelope()
		if !ok {
			return "", managedKeyMissing
		}
		if s == nil || s.profiles == nil {
			return "", managedKeyUnreadable
		}
		plain, opened := s.profiles.DecryptSecretEnvelope(envelope)
		if !opened {
			return "", managedKeyUnreadable
		}
		trimmed := strings.TrimSpace(plain)
		if trimmed == "" {
			return "", managedKeyMissing
		}
		return trimmed, managedKeyAvailable
	default:
		return "", managedKeyMissing
	}
}

// decodeGovernanceSecret classifies one stored managedRuntimeKey value.
func decodeGovernanceSecret(raw json.RawMessage) *llmgatewayprofiles.SecretValue {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var secret llmgatewayprofiles.SecretValue
	if err := json.Unmarshal(raw, &secret); err != nil {
		return nil
	}
	return &secret
}

// jsBoolean mirrors `typeof value === "boolean" ? value : fallback`.
func jsBoolean(raw json.RawMessage, fallback bool) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return fallback
	}
	switch string(trimmed) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

// jsNumber mirrors Number(value) and reports whether the result is finite.
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch string(trimmed) {
	case "null":
		// Number(null) === 0; this is why an explicit null budget means zero
		// instead of "inherit".
		return 0, true
	case "true":
		return 1, true
	case "false":
		return 0, true
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return 0, false
		}
		return javascriptNumberFromString(text)
	}
	var parsed float64
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// javascriptNumberFromString reproduces Number(string): trimmed input, an empty
// string is zero, and anything else that is not a decimal literal is NaN.
func javascriptNumberFromString(text string) (float64, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0, true
	}
	if trimmed == "Infinity" || trimmed == "+Infinity" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// budgetValue mirrors asBudget: non-finite inherits, otherwise clamp to
// [0, 1000000] and round to four decimals.
func budgetValue(raw json.RawMessage, fallback float64) float64 {
	parsed, ok := jsNumber(raw)
	if !ok {
		return fallback
	}
	clamped := math.Max(0, math.Min(maxBudgetUSD, parsed))
	return math.Round(clamped*1e4) / 1e4
}

// parallelValue mirrors asParallelRequests: non-finite inherits, otherwise
// truncate and clamp to [1, 1024].
func parallelValue(raw json.RawMessage, fallback int) int {
	parsed, ok := jsNumber(raw)
	if !ok {
		return fallback
	}
	truncated := math.Trunc(parsed)
	if truncated < minParallelRequests {
		return minParallelRequests
	}
	if truncated > maxParallelRequests {
		return maxParallelRequests
	}
	return int(truncated)
}

// optionalString mirrors normalizeOptionalString: a trimmed non-empty string or
// nil.
func optionalString(raw json.RawMessage) *string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return nil
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	return &text
}

// isoString mirrors normalizeIsoString: a parsable timestamp re-rendered as an
// ISO string with milliseconds, otherwise nil.
func isoString(raw json.RawMessage) *string {
	text := optionalString(raw)
	if text == nil {
		return nil
	}
	parsed, err := parseJSTime(*text)
	if err != nil {
		return nil
	}
	value := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
	return &value
}

// parseJSTime accepts the timestamp shapes new Date() handles in this document:
// RFC 3339 with or without fractional seconds.
func parseJSTime(value string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999Z0700",
		"2006-01-02T15:04:05Z0700",
	}
	var lastErr error
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, nil
		}
		lastErr = err
	}
	return time.Time{}, lastErr
}

// hasManagedRuntimeKey mirrors `resolved.managedRuntimeKeyState !== "missing"`:
// an unreadable key still counts as configured.
func (r resolvedGovernance) hasManagedRuntimeKey() bool {
	return r.ManagedRuntimeKeyState != managedKeyMissing
}

// normalizeSecret mirrors the NestJS normalizeSecret: trim, drop a leading
// "Bearer " (case insensitive), and collapse an empty result to "".
func normalizeSecret(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "bearer") {
		rest := strings.TrimSpace(trimmed[len("bearer"):])
		return strings.TrimSpace(rest)
	}
	return trimmed
}

// truncateUTF16 mirrors String.prototype.slice for a positive limit: the limit
// counts UTF-16 code units, so a surrogate pair can be cut in half exactly like
// JavaScript does.
func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if limit >= len(units) {
		return value
	}
	if limit <= 0 {
		return ""
	}
	return string(utf16.Decode(units[:limit]))
}

// jsLength is the UTF-16 length JavaScript reports for a string.
func jsLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}
