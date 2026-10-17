package workspace

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func TestRegisterAddsTheTwelveRootsAndFieldPermissions(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, nil, nil, nil)
	for _, name := range []string{
		"me", "myOrganizations", "users", "userLoginRecords", "roles", "permissions",
		"memberships", "dashboards", "queueStats", "entitySentimentSeries",
		"topicSentimentSeries", "processedItemById",
	} {
		if _, ok := reg.Root(name); !ok {
			t.Fatalf("root %s is not registered", name)
		}
	}
	for typeName, fields := range map[string][]string{
		"UserModel":       {"primaryRoleId", "isActive", "emailVerified", "lastLoginAt", "roleIds"},
		"RoleModel":       {"permissions"},
		"MembershipModel": {"role", "roles", "user"},
	} {
		for _, field := range fields {
			permission, ok := reg.FieldPermission(typeName, field)
			if !ok || permission == "" {
				t.Fatalf("field permission %s.%s is missing", typeName, field)
			}
		}
	}
	if permission, _ := reg.FieldPermission("UserModel", "roleIds"); permission != "users.read" {
		t.Fatalf("UserModel.roleIds permission = %q", permission)
	}
	if permission, _ := reg.FieldPermission("RoleModel", "permissions"); permission != "roles.read" {
		t.Fatalf("RoleModel.permissions permission = %q", permission)
	}
}

func TestDecodeUserCursor(t *testing.T) {
	encoded := "dXNlci0x" // base64("user-1")
	id, valid := decodeUserCursor(encoded)
	if !valid || id != "user-1" {
		t.Fatalf("decoded = %q valid=%v", id, valid)
	}
	if id, valid := decodeUserCursor(""); !valid || id != "" {
		t.Fatalf("empty cursor = %q valid=%v", id, valid)
	}
	if _, valid := decodeUserCursor("not base64!"); valid {
		t.Fatal("invalid base64 must fail closed")
	}
}

func TestIsObjectID(t *testing.T) {
	if !isObjectID("64c0000000000000000000a1") {
		t.Fatal("valid ObjectId rejected")
	}
	for _, value := range []string{"bad-id", "", "64c0000000000000000000g1", "64c0000000000000000000a"} {
		if isObjectID(value) {
			t.Fatalf("invalid id accepted: %q", value)
		}
	}
}

func TestNormalizeProcessedResultFollowsTheNestNormalizer(t *testing.T) {
	object := normalizeProcessedResult(json.RawMessage(`"{\"a\":1}"`))
	if string(object) != `{"a":1}` {
		t.Fatalf("parsed string = %s", object)
	}
	nested := normalizeProcessedResult(json.RawMessage(`"\"{\\\"b\\\":2}\""`))
	if string(nested) != `{"b":2}` {
		t.Fatalf("nested parse = %s", nested)
	}
	if got := normalizeProcessedResult(json.RawMessage(`"not json"`)); got != nil {
		t.Fatalf("invalid json = %s", got)
	}
	if got := normalizeProcessedResult(json.RawMessage(`"   "`)); got != nil {
		t.Fatalf("blank string = %s", got)
	}
	plain := normalizeProcessedResult(json.RawMessage(`{"c":3}`))
	if string(plain) != `{"c":3}` {
		t.Fatalf("object passthrough = %s", plain)
	}
	if got := normalizeProcessedResult(json.RawMessage("null")); got != nil {
		t.Fatalf("null = %s", got)
	}
}

// bsonParserProbe is the source document for the BSON reader test.
type bsonParserProbe struct {
	Title  string          `bson:"title"`
	Count  int32           `bson:"count"`
	Ratio  float64         `bson:"ratio"`
	Nested bsonNestedProbe `bson:"nested"`
	Items  []string        `bson:"items"`
	Ref    bson.ObjectID   `bson:"ref"`
}

type bsonNestedProbe struct {
	Flag bool `bson:"flag"`
}

func TestBSONDocumentToJSONParsesNestedTypes(t *testing.T) {
	objectID, err := bson.ObjectIDFromHex("64c0000000000000000000a1")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := bson.Marshal(bsonParserProbe{
		Title:  "hello \"world\"",
		Count:  7,
		Ratio:  1.5,
		Nested: bsonNestedProbe{Flag: true},
		Items:  []string{"a", "b"},
		Ref:    objectID,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, ok := bsonDocumentToJSON(raw)
	if !ok {
		t.Fatal("document did not parse")
	}
	var decoded struct {
		Title  string          `json:"title"`
		Count  int             `json:"count"`
		Ratio  float64         `json:"ratio"`
		Nested bsonNestedProbe `json:"nested"`
		Items  []string        `json:"items"`
		Ref    string          `json:"ref"`
	}
	if err := json.Unmarshal(token, &decoded); err != nil {
		t.Fatalf("decoded json: %v (%s)", err, token)
	}
	if decoded.Title != "hello \"world\"" || decoded.Count != 7 || decoded.Ratio != 1.5 {
		t.Fatalf("scalars = %+v", decoded)
	}
	if !decoded.Nested.Flag || len(decoded.Items) != 2 || decoded.Items[1] != "b" {
		t.Fatalf("nested = %+v", decoded)
	}
	if decoded.Ref != objectID.Hex() {
		t.Fatalf("object id = %q want %q", decoded.Ref, objectID.Hex())
	}
}

func TestNormalizeProcessedItemLlmRejectsNonDocumentsAndNonFinite(t *testing.T) {
	if model := normalizeProcessedItemLlm(bson.RawValue{}); model != nil {
		t.Fatal("missing llm must be null")
	}
	raw, err := bson.Marshal(struct {
		LLM string `bson:"llm"`
	}{LLM: "not-a-document"})
	if err != nil {
		t.Fatal(err)
	}
	if model := normalizeProcessedItemLlm(bson.Raw(raw).Lookup("llm")); model != nil {
		t.Fatal("non-document llm must be null")
	}

	document, err := bson.Marshal(struct {
		LLM struct {
			Model        string  `bson:"model"`
			PromptTokens float64 `bson:"promptTokens"`
			CostUSD      float64 `bson:"costUsd"`
			LatencyMs    float64 `bson:"latencyMs"`
		} `bson:"llm"`
	}{
		LLM: struct {
			Model        string  `bson:"model"`
			PromptTokens float64 `bson:"promptTokens"`
			CostUSD      float64 `bson:"costUsd"`
			LatencyMs    float64 `bson:"latencyMs"`
		}{Model: "gpt-4o", PromptTokens: math.NaN(), CostUSD: 0.25, LatencyMs: math.Inf(1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	model := normalizeProcessedItemLlm(bson.Raw(document).Lookup("llm"))
	if model == nil {
		t.Fatal("llm document must produce a model")
	}
	if model.Model == nil || *model.Model != "gpt-4o" {
		t.Fatalf("model = %v", model.Model)
	}
	if model.PromptTokens != nil || model.LatencyMs != nil {
		t.Fatalf("non-finite numbers must be null: %+v", model)
	}
	if model.CostUSD == nil || *model.CostUSD != 0.25 {
		t.Fatalf("costUsd = %v", model.CostUSD)
	}
}

func TestQueueEventFromLogRedactsSensitiveMessages(t *testing.T) {
	raw, err := bson.Marshal(struct {
		JobID   string `bson:"jobId"`
		Stage   string `bson:"stage"`
		Status  string `bson:"status"`
		Message string `bson:"message"`
	}{JobID: "job-1", Stage: "fetch", Status: "failed", Message: "upstream rejected Bearer secret.token.123"})
	if err != nil {
		t.Fatal(err)
	}
	document := bson.Raw(raw)
	event := queueEventFromLog(taskLogDoc{
		JobID:   document.Lookup("jobId"),
		Stage:   document.Lookup("stage"),
		Status:  document.Lookup("status"),
		Message: document.Lookup("message"),
	}, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	if event.Event != "FETCH:FAILED" {
		t.Fatalf("event = %q", event.Event)
	}
	if event.JobID != "job-1" {
		t.Fatalf("jobId = %q", event.JobID)
	}
	if event.Timestamp != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("timestamp = %q", event.Timestamp)
	}
	if event.Data == nil || strings.Contains(*event.Data, "secret.token.123") {
		t.Fatalf("message was not redacted: %v", event.Data)
	}
	if !strings.Contains(*event.Data, "Bearer [REDACTED]") {
		t.Fatalf("redaction shape = %v", event.Data)
	}
	if !strings.Contains(*event.Data, `"stage":"fetch"`) {
		t.Fatalf("data payload = %v", event.Data)
	}
}

func TestClampDaysAndJsonScalar(t *testing.T) {
	if got := clampDays(0, false); got != 30 {
		t.Fatalf("default days = %d", got)
	}
	if got := clampDays(0, true); got != 1 {
		t.Fatalf("low days = %d", got)
	}
	if got := clampDays(9999, true); got != 365 {
		t.Fatalf("high days = %d", got)
	}
	if jsonScalar(nil) != nil || jsonScalar([]byte("null")) != nil {
		t.Fatal("null json column must map to nil")
	}
	scalar := jsonScalar([]byte(`{"a":1}`))
	if scalar == nil || string(*scalar) != `{"a":1}` {
		t.Fatalf("json scalar = %v", scalar)
	}
}

func TestRawStringSliceAndErrorNormalization(t *testing.T) {
	raw, err := bson.Marshal(struct {
		Tags  []string `bson:"tags"`
		Error struct {
			Message string `bson:"message"`
		} `bson:"error"`
	}{Tags: []string{"a", "b"}, Error: struct {
		Message string `bson:"message"`
	}{Message: "boom"}})
	if err != nil {
		t.Fatal(err)
	}
	document := bson.Raw(raw)
	tags := rawStringSlice(document.Lookup("tags"))
	if len(tags) != 2 || tags[0] != "a" {
		t.Fatalf("tags = %v", tags)
	}
	normalized := normalizeProcessedItemError(document.Lookup("error"))
	if normalized == nil || normalized.Message != "boom" {
		t.Fatalf("error = %+v", normalized)
	}
}

func TestMembershipBundleEffectiveRoles(t *testing.T) {
	bundle := &membershipBundle{
		membership:  membershipRow{ID: "m1", RoleID: "r-primary", IsActive: true},
		roleLinks:   []string{"r-2", "r-1"},
		roles:       map[string]roleRow{"r-1": {ID: "r-1", Name: "analyst"}, "r-2": {ID: "r-2", Name: "admin", IsSystem: true}},
		permissions: map[string][]permissionRow{"r-1": {{ID: "p1", Name: "items.read"}}, "r-2": {{ID: "p2", Name: "users.read"}}},
	}
	roleIDs := bundle.effectiveRoleIDs()
	if len(roleIDs) != 2 || roleIDs[0] != "r-2" {
		t.Fatalf("role ids = %v", roleIDs)
	}
	if !bundle.isSystemAdmin() {
		t.Fatal("system admin role must be detected")
	}
	names := bundle.permissionNames()
	if len(names) != 2 || names[0] != "users.read" || names[1] != "items.read" {
		t.Fatalf("permissions = %v", names)
	}

	fallback := &membershipBundle{
		membership:  membershipRow{ID: "m2", RoleID: "r-primary", IsActive: true},
		roles:       map[string]roleRow{"r-primary": {ID: "r-primary", Name: "admin", IsSystem: true}},
		permissions: map[string][]permissionRow{"r-primary": {{ID: "p", Name: "users.read"}}},
	}
	if !fallback.isSystemAdmin() {
		t.Fatal("primary role fallback must be effective")
	}
	if ids := fallback.effectiveRoleIDs(); len(ids) != 1 || ids[0] != "r-primary" {
		t.Fatalf("fallback ids = %v", ids)
	}
}
