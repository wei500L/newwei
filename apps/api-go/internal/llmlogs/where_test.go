package llmlogs

import (
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestBuildWhereMirrorsService(t *testing.T) {
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	filter := logFilter{
		OrgID:       "org-1",
		Model:       " gpt-4o ",
		Feature:     "News",
		ProfileID:   "p1",
		RunID:       "r1",
		NodeID:      "n1",
		RequestType: "completion",
		Status:      "error",
		Start:       &start,
		End:         &end,
	}
	want := bson.D{
		{Key: "orgId", Value: "org-1"},
		{Key: "model", Value: "gpt-4o"},
		{Key: "requestType", Value: "completion"},
		{Key: "status", Value: "error"},
		{Key: "createdAt", Value: bson.D{
			{Key: "$gte", Value: start},
			{Key: "$lte", Value: end},
		}},
		{Key: "$and", Value: bson.A{
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "feature", Value: "news"}},
				bson.D{{Key: "metadata.feature", Value: "news"}},
			}}},
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "gatewayProfileId", Value: "p1"}},
				bson.D{{Key: "metadata.profileid", Value: "p1"}},
				bson.D{{Key: "metadata.crawlsiteprofileid", Value: "p1"}},
			}}},
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "metadata.runid", Value: "r1"}},
				bson.D{{Key: "metadata.frontierrunid", Value: "r1"}},
			}}},
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "metadata.nodeid", Value: "n1"}},
				bson.D{{Key: "metadata.frontiernodeid", Value: "n1"}},
			}}},
		}},
	}
	if got := buildWhere(filter); !reflect.DeepEqual(got, want) {
		t.Fatalf("buildWhere mismatch\ngot  %#v\nwant %#v", got, want)
	}
}

func TestBuildWhereRequiresOrgID(t *testing.T) {
	for _, orgID := range []string{"", "   "} {
		where := buildWhere(logFilter{OrgID: orgID})
		if !reflect.DeepEqual(where, bson.D{{Key: "orgId", Value: unknownOrgID}}) {
			t.Fatalf("orgID %q -> %#v", orgID, where)
		}
	}
}

func TestBuildWhereOnlyRunIDAndNodeID(t *testing.T) {
	where := buildWhere(logFilter{OrgID: "org-1", RunID: "r1", NodeID: "n1"})
	want := bson.D{
		{Key: "orgId", Value: "org-1"},
		{Key: "$and", Value: bson.A{
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "metadata.runid", Value: "r1"}},
				bson.D{{Key: "metadata.frontierrunid", Value: "r1"}},
			}}},
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "metadata.nodeid", Value: "n1"}},
				bson.D{{Key: "metadata.frontiernodeid", Value: "n1"}},
			}}},
		}},
	}
	if !reflect.DeepEqual(where, want) {
		t.Fatalf("got %#v", where)
	}
	// 非法 feature 不参与过滤（normalizeFeatureToken 返回 undefined 语义）。
	invalid := buildWhere(logFilter{OrgID: "org-1", Feature: "Bad Upper"})
	if !reflect.DeepEqual(invalid, bson.D{{Key: "orgId", Value: "org-1"}}) {
		t.Fatalf("invalid feature leaked into where: %#v", invalid)
	}
}

func TestNormalizeFilterForExportKeepsRunIDAndNodeID(t *testing.T) {
	filter := logFilter{
		OrgID:       " org-1 ",
		Model:       " gpt-4o ",
		Feature:     "News",
		ProfileID:   " p1 ",
		RunID:       " r1 ",
		NodeID:      " n1 ",
		RequestType: "completion",
		Status:      "error",
	}
	normalized := normalizeFilterForExport(filter)
	if normalized.OrgID != "org-1" || normalized.Model != "gpt-4o" || normalized.Feature != "news" ||
		normalized.ProfileID != "p1" || normalized.RunID != "r1" || normalized.NodeID != "n1" {
		t.Fatalf("normalized=%+v", normalized)
	}
	// 导出与列表必须得到同一套 runId/nodeId 条件——这是漏过滤缺陷的 Go 侧修复。
	exportWhere := buildWhere(normalized)
	listWhere := buildWhere(logFilter{
		OrgID: "org-1", Model: " gpt-4o ", Feature: "News", ProfileID: " p1 ",
		RunID: " r1 ", NodeID: " n1 ", RequestType: "completion", Status: "error",
	})
	if !reflect.DeepEqual(exportWhere, listWhere) {
		t.Fatalf("export where %#v != list where %#v", exportWhere, listWhere)
	}
	if len(exportWhere) != 5 {
		t.Fatalf("export where lost conditions: %#v", exportWhere)
	}
	// 超长 runId/nodeId 在服务层归一化时被丢弃（normalizeProfileId → null）。
	dropped := normalizeFilterForExport(logFilter{
		OrgID:  "org-1",
		RunID:  string(make([]byte, 129)),
		NodeID: string(make([]byte, 129)),
	})
	if dropped.RunID != "" || dropped.NodeID != "" {
		t.Fatalf("over-long ids kept: %+v", dropped)
	}
}

func TestValidateExportDateWindow(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	plus90 := base.AddDate(0, 0, 90)
	plus91 := base.AddDate(0, 0, 91)

	if err := ValidateExportDateWindow(logFilter{}); err != nil {
		t.Fatalf("empty window rejected: %v", err)
	}
	if err := ValidateExportDateWindow(logFilter{Start: &base}); err != nil {
		t.Fatalf("start-only window rejected: %v", err)
	}
	if err := ValidateExportDateWindow(logFilter{Start: &base, End: &plus90}); err != nil {
		t.Fatalf("90 days rejected: %v", err)
	}
	err := ValidateExportDateWindow(logFilter{Start: &base, End: &plus91})
	if err == nil {
		t.Fatal("91 days accepted")
	}
	if messageOf(t, err) != "export date range cannot exceed 90 days" {
		t.Fatalf("message=%q", messageOf(t, err))
	}
	reversed := base.AddDate(0, 0, -1)
	err = ValidateExportDateWindow(logFilter{Start: &base, End: &reversed})
	if err == nil || messageOf(t, err) != "start must be earlier than or equal to end" {
		t.Fatalf("reversed window err=%v", err)
	}
}

func TestSafeNumberAndIntegerMirrorJS(t *testing.T) {
	if got := toSafeInteger(nil); got != 0 {
		t.Fatalf("null integer got %d", got)
	}
	if got := toSafeNumber(float64(2.5)); got != 2.5 {
		t.Fatalf("float got %v", got)
	}
	if got := toSafeInteger(float64(2.9)); got != 2 {
		t.Fatalf("trunc got %d", got)
	}
	if got := toSafeInteger(int64(7)); got != 7 {
		t.Fatalf("int64 got %d", got)
	}
	if got := toSafeNumber("3.5"); got != 3.5 {
		t.Fatalf("numeric string got %v", got)
	}
	if got := toSafeNumber("not-a-number"); got != 0 {
		t.Fatalf("NaN got %v", got)
	}
}
