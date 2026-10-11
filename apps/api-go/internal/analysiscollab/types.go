package analysiscollab

import "context"

// UserSummary 的 JSON 键与 Nest toUserSummary 一致。avatarUrl 缺失时为 null。
type UserSummary struct {
	ID        string  `json:"id"`
	Email     string  `json:"email"`
	FirstName string  `json:"firstName"`
	LastName  string  `json:"lastName"`
	AvatarURL *string `json:"avatarUrl"`
}

// QueryState 始终是对象，queryString 至少是空字符串。
type QueryState struct {
	QueryString string `json:"queryString"`
}

// SavedView 是视图列表和详情的一条记录。canEdit 由调用方按 owner/users.write 填。
type SavedView struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Description *string     `json:"description"`
	Surface     string      `json:"surface"`
	RoutePath   string      `json:"routePath"`
	QueryState  QueryState  `json:"queryState"`
	Visibility  string      `json:"visibility"`
	CreatedAt   string      `json:"createdAt"`
	UpdatedAt   string      `json:"updatedAt"`
	CreatedBy   UserSummary `json:"createdBy"`
	UpdatedBy   UserSummary `json:"updatedBy"`
	CanEdit     bool        `json:"canEdit"`
}

// BoardSummary 是看板列表元素。活跃看板的 archivedAt 仍输出 null。
type BoardSummary struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Description *string     `json:"description"`
	ArchivedAt  *string     `json:"archivedAt"`
	CreatedAt   string      `json:"createdAt"`
	UpdatedAt   string      `json:"updatedAt"`
	CreatedBy   UserSummary `json:"createdBy"`
	UpdatedBy   UserSummary `json:"updatedBy"`
	ColumnCount int         `json:"columnCount"`
	TaskCount   int         `json:"taskCount"`
}

// TaskCard 是卡片。新建时 commentCount 来自真实讨论，没有讨论就是 0。
type TaskCard struct {
	ID                string       `json:"id"`
	BoardID           string       `json:"boardId"`
	ColumnID          string       `json:"columnId"`
	Title             string       `json:"title"`
	BodyMarkdown      *string      `json:"bodyMarkdown"`
	Priority          string       `json:"priority"`
	AssigneeID        *string      `json:"assigneeId"`
	Assignee          *UserSummary `json:"assignee"`
	LinkedSubjectType *string      `json:"linkedSubjectType"`
	LinkedSubjectID   *string      `json:"linkedSubjectId"`
	DueAt             *string      `json:"dueAt"`
	SortOrder         int          `json:"sortOrder"`
	CommentCount      int          `json:"commentCount"`
	CreatedAt         string       `json:"createdAt"`
	UpdatedAt         string       `json:"updatedAt"`
	CreatedBy         UserSummary  `json:"createdBy"`
	UpdatedBy         UserSummary  `json:"updatedBy"`
}

// BoardColumn 内的 tasks 没有行时是空数组，不是 null。
type BoardColumn struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Color     *string    `json:"color"`
	SortOrder int        `json:"sortOrder"`
	IsDone    bool       `json:"isDone"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt string     `json:"updatedAt"`
	Tasks     []TaskCard `json:"tasks"`
}

// BoardDetail 是看板详情、列操作、移动任务的响应。
type BoardDetail struct {
	ID          string        `json:"id"`
	Title       string        `json:"title"`
	Description *string       `json:"description"`
	ArchivedAt  *string       `json:"archivedAt"`
	CreatedAt   string        `json:"createdAt"`
	UpdatedAt   string        `json:"updatedAt"`
	CreatedBy   UserSummary   `json:"createdBy"`
	UpdatedBy   UserSummary   `json:"updatedBy"`
	Columns     []BoardColumn `json:"columns"`
}

// Comment 按 createdAt 升序嵌在 Thread 里，单独更新时也是这个形状。
type Comment struct {
	ID           string      `json:"id"`
	CreatedByID  string      `json:"createdById"`
	BodyMarkdown string      `json:"bodyMarkdown"`
	CreatedAt    string      `json:"createdAt"`
	UpdatedAt    string      `json:"updatedAt"`
	CreatedBy    UserSummary `json:"createdBy"`
}

// Thread 在 GET 没有记录时不使用这个结构，响应体是 JSON null。
type Thread struct {
	ID           string      `json:"id"`
	SubjectType  string      `json:"subjectType"`
	SubjectID    string      `json:"subjectId"`
	NoteMarkdown *string     `json:"noteMarkdown"`
	CreatedAt    string      `json:"createdAt"`
	UpdatedAt    string      `json:"updatedAt"`
	CreatedBy    UserSummary `json:"createdBy"`
	UpdatedBy    UserSummary `json:"updatedBy"`
	Comments     []Comment   `json:"comments"`
}

// BoardReader 由看板服务实现，任务移动后用它返回完整看板。
// 实现必须包含 ensureDefaultBoard 的副作用，并且直接数评论，不发 HTTP。
type BoardReader interface {
	GetBoard(ctx context.Context, orgID string, actor Actor, boardID string) (BoardDetail, error)
}
