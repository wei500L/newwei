package analysiscollab

import "net/http"

const (
	PermAnalysisRead  = "analysis.read"
	PermAnalysisWrite = "analysis.write"
	PermUsersWrite    = "users.write"

	SortStep = 1000

	SurfaceSearch = "search"
	SurfaceItems  = "items"
	SurfaceEvents = "events"

	VisibilityPrivate   = "private"
	VisibilityOrgShared = "org_shared"

	SubjectSavedView     = "saved_view"
	SubjectItem          = "item"
	SubjectEvent         = "event"
	SubjectAnalysisTask  = "analysis_task"
	PriorityLow          = "low"
	PriorityNormal       = "normal"
	PriorityHigh         = "high"
	PriorityUrgent       = "urgent"
	DefaultBoardTitle    = "Team board"

	MsgViewNotFound         = "Saved analysis view not found"
	MsgBoardNotFound        = "Analysis board not found"
	MsgColumnNotFound       = "Analysis board column not found"
	MsgTargetColumnNotFound = "Target analysis board column not found"
	MsgTaskNotFound         = "Analysis task not found"
	MsgSubjectNotFound      = "Analysis subject not found"
	MsgCommentNotFound      = "Analysis comment not found"
	MsgLastBoard            = "Cannot archive the last analysis board"
	MsgBoardArchived        = "Analysis board is already archived"
	MsgLastColumn           = "Cannot delete the last board column"
	MsgSameColumn           = "Target column must be different"
	MsgColumnOrder          = "Column order must include every board column"
	MsgNoColumns            = "Analysis board has no columns"
	MsgAssignee             = "Assignee must be an active org member"
	MsgLinkedTogether       = "linkedSubjectType and linkedSubjectId must be provided together"
	MsgEditResource         = "You do not have permission to edit this resource"
	MsgEditComment          = "You do not have permission to edit this comment"
	MsgEnumParam            = "Validation failed (enum string is expected)"
)

// DefaultColumns 是组织第一次读取看板时创建的五列。sortOrder 为 (index+1)*SortStep。
var DefaultColumns = []struct {
	Title  string
	Color  string
	IsDone bool
}{
	{Title: "Backlog", Color: "default", IsDone: false},
	{Title: "Triage", Color: "orange", IsDone: false},
	{Title: "In progress", Color: "blue", IsDone: false},
	{Title: "Review", Color: "purple", IsDone: false},
	{Title: "Done", Color: "green", IsDone: true},
}

// Actor 是请求上的服务端身份。Has 来自 MySQL RBAC，不是 JWT permissions。
type Actor struct {
	ID  string
	Has func(permission string) bool
}

// Allows 在 Has 为空时返回 false，避免测试里的空身份 panic。
func (a Actor) Allows(permission string) bool {
	return a.Has != nil && a.Has(permission)
}

// CanManageOwned 是保存视图 canEdit、更新/删除视图，以及评论编辑/删除的管理判断。
func (a Actor) CanManageOwned(ownerID string) bool {
	return a.ID == ownerID || a.Allows(PermUsersWrite)
}

// CanReadSavedView 只看创建者或 org_shared。users.write 不能绕过私有视图的读取。
func CanReadSavedView(createdByID, visibility, userID string) bool {
	return createdByID == userID || visibility == VisibilityOrgShared
}

// SortOrder 是 1-based 下标对应的 sortOrder。
func SortOrder(index int) int {
	return (index + 1) * SortStep
}

// ValidColumnOrder 要求 columnIDs 是 existing 的完整、无重复排列。
func ValidColumnOrder(columnIDs, existing []string) bool {
	if len(columnIDs) != len(existing) {
		return false
	}
	have := make(map[string]struct{}, len(existing))
	for _, id := range existing {
		if _, dup := have[id]; dup {
			return false
		}
		have[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(columnIDs))
	for _, id := range columnIDs {
		if _, dup := seen[id]; dup {
			return false
		}
		seen[id] = struct{}{}
		if _, ok := have[id]; !ok {
			return false
		}
	}
	return true
}

// PlanTaskMove 复刻 AnalysisWorkspaceService.moveTask 的插入位置。
// orderedIDs 是目标列在移动前的顺序；同列时其中包含 taskID。
// requested 与 sourceIndex 的比较使用未 clamp 的请求值，减法作用在 clamp 之后。
func PlanTaskMove(taskID string, orderedIDs []string, sameColumn bool, requested int) []string {
	sourceIndex := -1
	order := make([]string, 0, len(orderedIDs))
	for index, id := range orderedIDs {
		if id == taskID {
			sourceIndex = index
			continue
		}
		order = append(order, id)
	}
	targetIndex := requested
	if targetIndex < 0 {
		targetIndex = 0
	}
	if targetIndex > len(order) {
		targetIndex = len(order)
	}
	if sameColumn && requested > sourceIndex {
		targetIndex--
		if targetIndex < 0 {
			targetIndex = 0
		}
	}
	out := make([]string, 0, len(order)+1)
	out = append(out, order[:targetIndex]...)
	out = append(out, taskID)
	out = append(out, order[targetIndex:]...)
	return out
}

// StatusError 是已经确定的 HTTP 业务错误。数据库错误保持为普通 error。
type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func BadRequest(message string) error {
	return &StatusError{Status: http.StatusBadRequest, Message: message}
}

func NotFound(message string) error {
	return &StatusError{Status: http.StatusNotFound, Message: message}
}

func Forbidden(message string) error {
	return &StatusError{Status: http.StatusForbidden, Message: message}
}
