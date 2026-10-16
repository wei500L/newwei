package adminlogs

import (
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// orgId 条件恒在（跨组织隔离），kind 非空时必须生效——本批 smoke 首跑就是
// 靠 `/api/admin/logs/errors?kind=http` 的 Nest/Go 差分抓到「严格端点漏了
// kind 条件」的缺陷，这里锁定它不再回归。
func TestBuildExceptionFilterAppliesOrgAndKind(t *testing.T) {
	filter := buildExceptionFilter("org-1", "http", "", "", nil, nil)
	if len(filter) != 2 {
		t.Fatalf("filter = %#v", filter)
	}
	if filter[0].Key != "orgId" || filter[0].Value != "org-1" {
		t.Fatalf("orgId clause = %#v", filter[0])
	}
	if filter[1].Key != "kind" || filter[1].Value != "http" {
		t.Fatalf("kind clause = %#v", filter[1])
	}
	// kind 为空时不加该条件（admin/errors 的宽松语义），但 orgId 仍在。
	loose := buildExceptionFilter("org-1", "", "", "", nil, nil)
	if len(loose) != 1 || loose[0].Key != "orgId" || loose[0].Value != "org-1" {
		t.Fatalf("loose filter = %#v", loose)
	}
}

func TestBuildExceptionFilterAppliesTextAndDate(t *testing.T) {
	start := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	filter := buildExceptionFilter("org-1", "graphql", "alphaOp", "a.b*c", &start, &end)
	if len(filter) != 5 {
		t.Fatalf("filter = %#v", filter)
	}
	if filter[1].Key != "kind" || filter[1].Value != "graphql" {
		t.Fatalf("kind = %#v", filter[1])
	}
	if filter[2].Key != "operationName" || filter[2].Value != "alphaOp" {
		t.Fatalf("operationName = %#v", filter[2])
	}
	message, ok := filter[3].Value.(bson.D)
	if filter[3].Key != "message" || !ok || len(message) != 2 {
		t.Fatalf("message = %#v", filter[3])
	}
	if message[0].Key != "$regex" || message[0].Value != `a\.b\*c` {
		t.Fatalf("regex = %#v", message[0])
	}
	if message[1].Key != "$options" || message[1].Value != "i" {
		t.Fatalf("options = %#v", message[1])
	}
	window, ok := filter[4].Value.(bson.D)
	if filter[4].Key != "timestamp" || !ok || len(window) != 2 {
		t.Fatalf("timestamp = %#v", filter[4])
	}
	if window[0].Key != "$gte" || window[1].Key != "$lte" {
		t.Fatalf("timestamp = %#v", window)
	}
}

func TestBuildTaskLogWhereAlwaysScopesOrg(t *testing.T) {
	where := buildTaskLogWhere("org-1", taskLogFilters{queue: "q", status: "failed"})
	if len(where) != 3 {
		t.Fatalf("where = %#v", where)
	}
	if where[0].Key != "orgId" || where[0].Value != "org-1" {
		t.Fatalf("orgId clause = %#v", where[0])
	}
	if where[1].Key != "queue" || where[2].Key != "status" {
		t.Fatalf("where = %#v", where)
	}
	empty := buildTaskLogWhere("org-1", taskLogFilters{})
	if len(empty) != 1 || empty[0].Key != "orgId" {
		t.Fatalf("empty where = %#v", empty)
	}
}
