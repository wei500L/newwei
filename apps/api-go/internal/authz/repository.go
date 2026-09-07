// authz 的 repository 接口（实现见 mysql_repository.go）。
package authz

import "context"

// Repository 是授权重推导的查询接口。
type Repository interface {
	// Authorize 对已验签的 (userID, orgID) 执行 membership/user/permission
	// 重推导。
	//
	// 返回值语义：
	//   - (*Authorization, nil)     全部通过——调用方可信任该身份；
	//   - (nil, *Rejection)         数据库状态拒绝——401 + Rejection.Message；
	//   - (nil, error)              查询失败（MySQL 不可达等）——调用方
	//                              fail-closed（503），绝不放行。
	//
	// userID/orgID 只作为参数化查询条件（来自已验签 JWT claim），不从
	// 请求 body/query/header 读取任何组织上下文。
	Authorize(ctx context.Context, userID, orgID string) (*Authorization, error)
}
