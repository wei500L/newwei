package crawlworkflow

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"time"
)

// settingsDiffEntry 对齐 buildSettingsDiff 的条目形状。
type settingsDiffEntry struct {
	Key   string `json:"key"`
	Left  any    `json:"left"`
	Right any    `json:"right"`
}

// nodeChange 对齐 buildNodeDiff 的 changed 条目。
type nodeChange struct {
	ID            string       `json:"id"`
	Left          WorkflowNode `json:"left"`
	Right         WorkflowNode `json:"right"`
	ChangedFields []string     `json:"changedFields"`
}

type nodeDiff struct {
	Added   []WorkflowNode `json:"added"`
	Removed []WorkflowNode `json:"removed"`
	Changed []nodeChange   `json:"changed"`
}

type edgeDiff struct {
	Added   []WorkflowEdge `json:"added"`
	Removed []WorkflowEdge `json:"removed"`
}

// versionCompareSummary 对齐 compareVersions 的 summary 计数。
type versionCompareSummary struct {
	NodeCountDelta       int `json:"nodeCountDelta"`
	EdgeCountDelta       int `json:"edgeCountDelta"`
	ChangedSettingsCount int `json:"changedSettingsCount"`
	AddedNodeCount       int `json:"addedNodeCount"`
	RemovedNodeCount     int `json:"removedNodeCount"`
	ChangedNodeCount     int `json:"changedNodeCount"`
	AddedEdgeCount       int `json:"addedEdgeCount"`
	RemovedEdgeCount     int `json:"removedEdgeCount"`
}

type definitionDiff struct {
	LeftSettings  WorkflowSettings    `json:"leftSettings"`
	RightSettings WorkflowSettings    `json:"rightSettings"`
	LeftNodeIDs   []string            `json:"leftNodeIds"`
	RightNodeIDs  []string            `json:"rightNodeIds"`
	Settings      []settingsDiffEntry `json:"settings"`
	Nodes         nodeDiff            `json:"nodes"`
	Edges         edgeDiff            `json:"edges"`
}

type bindingWorkflow struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	PublishedVersionID *string `json:"publishedVersionId"`
}

// bindingItem 对齐 mapBindingRecord：profiles 带 matchHost，newsSources
// 带 url（extra 追加在 updatedAt 之后）。
type bindingItem struct {
	ID                  string    `json:"id"`
	Name                string    `json:"name"`
	WorkflowID          *string   `json:"workflowId"`
	WorkflowVersionID   *string   `json:"workflowVersionId"`
	WorkflowBindingMode string    `json:"workflowBindingMode"`
	AppliesTo           string    `json:"appliesTo"`
	UpdatedAt           *nestTime `json:"updatedAt"`
	MatchHost           *string   `json:"matchHost,omitempty"`
	URL                 *string   `json:"url,omitempty"`
}

type bindingGroup struct {
	Total                   int           `json:"total"`
	FollowingPublishedCount int           `json:"followingPublishedCount"`
	LeftVersionCount        int           `json:"leftVersionCount"`
	RightVersionCount       int           `json:"rightVersionCount"`
	Items                   []bindingItem `json:"items"`
}

type bindingImpact struct {
	Workflows   []bindingWorkflow `json:"workflows"`
	Profiles    bindingGroup      `json:"profiles"`
	NewsSources bindingGroup      `json:"newsSources"`
}

type compareResult struct {
	Left           versionDocument       `json:"left"`
	Right          versionDocument       `json:"right"`
	Summary        versionCompareSummary `json:"summary"`
	DefinitionDiff definitionDiff        `json:"definitionDiff"`
	BindingImpact  bindingImpact         `json:"bindingImpact"`
}

// buildSettingsDiff 镜像 buildSettingsDiff：键取并集、字典序排序、
// JSON.stringify 不等的才留下，值 `left[key] ?? null`。
func buildSettingsDiff(left, right WorkflowSettings) []settingsDiffEntry {
	leftMap := settingsMap(left)
	rightMap := settingsMap(right)
	keys := make([]string, 0, len(leftMap)+len(rightMap))
	seen := map[string]bool{}
	for key := range leftMap {
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	for key := range rightMap {
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	out := []settingsDiffEntry{}
	for _, key := range keys {
		leftValue, leftOK := leftMap[key]
		rightValue, rightOK := rightMap[key]
		leftString := "undefined"
		if leftOK {
			leftString = jsonStringify(leftValue)
		}
		rightString := "undefined"
		if rightOK {
			rightString = jsonStringify(rightValue)
		}
		if leftString == rightString {
			continue
		}
		entry := settingsDiffEntry{Key: key, Left: nil, Right: nil}
		if leftOK && leftValue != nil {
			entry.Left = leftValue
		}
		if rightOK && rightValue != nil {
			entry.Right = rightValue
		}
		out = append(out, entry)
	}
	return out
}

func settingsMap(settings WorkflowSettings) map[string]any {
	encoded, err := json.Marshal(settings)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

// buildNodeDiff 镜像 buildNodeDiff：added/removed 按各自数组原顺序；
// changed 按左侧数组顺序，逐字段 JSON.stringify 比较 type/label/
// position/config/uiState（uiState 先 ?? null）。右侧 id 重复时后者覆盖
// （对应 JS Map 的覆盖语义）。
func buildNodeDiff(leftNodes, rightNodes []WorkflowNode) nodeDiff {
	rightByID := map[string]WorkflowNode{}
	for _, node := range rightNodes {
		rightByID[node.ID] = node
	}
	leftByID := map[string]bool{}
	for _, node := range leftNodes {
		leftByID[node.ID] = true
	}

	added := []WorkflowNode{}
	for _, node := range rightNodes {
		if !leftByID[node.ID] {
			added = append(added, node)
		}
	}
	removed := []WorkflowNode{}
	for _, node := range leftNodes {
		if _, ok := rightByID[node.ID]; !ok {
			removed = append(removed, node)
		}
	}
	changed := []nodeChange{}
	for _, node := range leftNodes {
		next, ok := rightByID[node.ID]
		if !ok {
			continue
		}
		fields := []string{}
		if node.Type != next.Type {
			fields = append(fields, "type")
		}
		if node.Label != next.Label {
			fields = append(fields, "label")
		}
		if jsonStringify(node.Position) != jsonStringify(next.Position) {
			fields = append(fields, "position")
		}
		if !rawEqual(node.Config, next.Config) {
			fields = append(fields, "config")
		}
		if !rawEqualNullable(node.UIState, next.UIState) {
			fields = append(fields, "uiState")
		}
		if len(fields) == 0 {
			continue
		}
		changed = append(changed, nodeChange{ID: node.ID, Left: node, Right: next, ChangedFields: fields})
	}

	return nodeDiff{Added: added, Removed: removed, Changed: changed}
}

// buildEdgeDiff 镜像 buildEdgeDiff：边签名 = JSON.stringify 的
// {source,target,sourceHandle ?? null,targetHandle ?? null,condition ?? null,
// priority ?? null}。签名一致即视为同一条边。
func buildEdgeDiff(leftEdges, rightEdges []WorkflowEdge) edgeDiff {
	leftSignatures := map[string]bool{}
	for _, edge := range leftEdges {
		leftSignatures[edgeSignature(edge)] = true
	}
	rightSignatures := map[string]bool{}
	for _, edge := range rightEdges {
		rightSignatures[edgeSignature(edge)] = true
	}
	added := []WorkflowEdge{}
	for _, edge := range rightEdges {
		if !leftSignatures[edgeSignature(edge)] {
			added = append(added, edge)
		}
	}
	removed := []WorkflowEdge{}
	for _, edge := range leftEdges {
		if !rightSignatures[edgeSignature(edge)] {
			removed = append(removed, edge)
		}
	}
	return edgeDiff{Added: added, Removed: removed}
}

func edgeSignature(edge WorkflowEdge) string {
	payload := map[string]any{
		"source":       edge.Source,
		"target":       edge.Target,
		"sourceHandle": edge.SourceHandle,
		"targetHandle": edge.TargetHandle,
		"condition":    edge.Condition,
		"priority":     edge.Priority,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// buildBindingImpact 镜像 buildBindingImpact：workflows 取本组织内的
// 两个工作流，profiles / newsSources 只统计本组织（orgId 条件）的绑定。
func (s *Service) buildBindingImpact(ctx context.Context, orgID string, left, right versionDocument) (bindingImpact, error) {
	workflowIDs := uniqueNonEmpty([]string{left.WorkflowID, right.WorkflowID})
	versionIDs := uniqueNonEmpty([]string{left.ID, right.ID})

	workflows, err := s.queryBindingWorkflows(ctx, orgID, workflowIDs)
	if err != nil {
		return bindingImpact{}, err
	}
	profiles, err := s.queryBindingProfiles(ctx, orgID, workflowIDs, versionIDs)
	if err != nil {
		return bindingImpact{}, err
	}
	newsSources, err := s.queryBindingNewsSources(ctx, orgID, workflowIDs, versionIDs)
	if err != nil {
		return bindingImpact{}, err
	}

	workflowByID := map[string]bindingWorkflow{}
	for _, workflow := range workflows {
		workflowByID[workflow.ID] = workflow
	}
	classifyUsage := func(workflowID, workflowVersionID *string) string {
		if workflowVersionID != nil {
			if *workflowVersionID == left.ID {
				return "left_version"
			}
			if *workflowVersionID == right.ID {
				return "right_version"
			}
		}
		if workflowID != nil {
			if workflow, ok := workflowByID[*workflowID]; ok && workflow.PublishedVersionID != nil {
				if *workflow.PublishedVersionID == left.ID {
					return "published_left"
				}
				if *workflow.PublishedVersionID == right.ID {
					return "published_right"
				}
			}
		}
		return "other"
	}
	for index := range profiles {
		profiles[index].AppliesTo = classifyUsage(profiles[index].WorkflowID, profiles[index].WorkflowVersionID)
	}
	for index := range newsSources {
		newsSources[index].AppliesTo = classifyUsage(newsSources[index].WorkflowID, newsSources[index].WorkflowVersionID)
	}

	countGroup := func(items []bindingItem, leftVersionID, rightVersionID string) bindingGroup {
		group := bindingGroup{Total: len(items), Items: items}
		for _, item := range items {
			if item.WorkflowBindingMode == "published" {
				group.FollowingPublishedCount++
			}
			if item.WorkflowVersionID != nil {
				if *item.WorkflowVersionID == leftVersionID {
					group.LeftVersionCount++
				}
				if *item.WorkflowVersionID == rightVersionID {
					group.RightVersionCount++
				}
			}
		}
		return group
	}

	return bindingImpact{
		Workflows:   workflows,
		Profiles:    countGroup(profiles, left.ID, right.ID),
		NewsSources: countGroup(newsSources, left.ID, right.ID),
	}, nil
}

func (s *Service) queryBindingWorkflows(ctx context.Context, orgID string, workflowIDs []string) ([]bindingWorkflow, error) {
	if len(workflowIDs) == 0 {
		return []bindingWorkflow{}, nil
	}
	args := append([]any{orgID}, stringsToArgs(workflowIDs)...)
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, name, publishedVersionId FROM CrawlStrategyWorkflow WHERE orgId = ? AND id IN ("+placeholders(len(workflowIDs))+")",
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []bindingWorkflow{}
	for rows.Next() {
		var item bindingWorkflow
		var publishedID sql.NullString
		if err := rows.Scan(&item.ID, &item.Name, &publishedID); err != nil {
			return nil, err
		}
		item.PublishedVersionID = nullString(publishedID)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Service) queryBindingProfiles(ctx context.Context, orgID string, workflowIDs, versionIDs []string) ([]bindingItem, error) {
	args := append([]any{orgID}, stringsToArgs(workflowIDs)...)
	args = append(args, stringsToArgs(versionIDs)...)
	query := "SELECT id, name, matchHost, workflowId, workflowVersionId, workflowBindingMode, updatedAt FROM CrawlSiteProfile WHERE orgId = ? AND (workflowId IN (" +
		placeholders(len(workflowIDs)) + ") OR workflowVersionId IN (" + placeholders(len(versionIDs)) + ")) ORDER BY updatedAt DESC, createdAt DESC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []bindingItem{}
	for rows.Next() {
		var item bindingItem
		var matchHost string
		var workflowID, workflowVersionID sql.NullString
		var updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.Name, &matchHost, &workflowID, &workflowVersionID, &item.WorkflowBindingMode, &updatedAt); err != nil {
			return nil, err
		}
		item.WorkflowID = nullString(workflowID)
		item.WorkflowVersionID = nullString(workflowVersionID)
		item.UpdatedAt = nestFromTime(updatedAt)
		item.MatchHost = &matchHost
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Service) queryBindingNewsSources(ctx context.Context, orgID string, workflowIDs, versionIDs []string) ([]bindingItem, error) {
	args := append([]any{orgID}, stringsToArgs(workflowIDs)...)
	args = append(args, stringsToArgs(versionIDs)...)
	query := "SELECT id, name, url, workflowId, workflowVersionId, workflowBindingMode, updatedAt FROM NewsSource WHERE orgId = ? AND (workflowId IN (" +
		placeholders(len(workflowIDs)) + ") OR workflowVersionId IN (" + placeholders(len(versionIDs)) + ")) ORDER BY updatedAt DESC, createdAt DESC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []bindingItem{}
	for rows.Next() {
		var item bindingItem
		var rawURL string
		var workflowID, workflowVersionID sql.NullString
		var updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.Name, &rawURL, &workflowID, &workflowVersionID, &item.WorkflowBindingMode, &updatedAt); err != nil {
			return nil, err
		}
		item.WorkflowID = nullString(workflowID)
		item.WorkflowVersionID = nullString(workflowVersionID)
		item.UpdatedAt = nestFromTime(updatedAt)
		item.URL = &rawURL
		out = append(out, item)
	}
	return out, rows.Err()
}

func uniqueNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func jsonStringify(value any) string {
	if value == nil {
		return "null"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// rawEqual 用规范化后的 JSON 文本比较两个透传对象——两侧都来自 MySQL
// JSON 列的规范文本（MySQL 对 JSON 对象做规范化存储），字节相等即
// JSON.stringify 相等。
func rawEqual(left, right json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(left), bytes.TrimSpace(right))
}

// rawEqualNullable 对 `uiState ?? null` 语义比较：两侧都缺失视为相等。
func rawEqualNullable(left, right json.RawMessage) bool {
	leftMissing := len(bytes.TrimSpace(left)) == 0
	rightMissing := len(bytes.TrimSpace(right)) == 0
	if leftMissing || rightMissing {
		return leftMissing == rightMissing
	}
	return rawEqual(left, right)
}
