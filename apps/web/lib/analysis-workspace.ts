export type SavedAnalysisSurface = "search" | "items" | "events";
export type SavedAnalysisVisibility = "private" | "org_shared";
export type AnalysisSubjectType = "saved_view" | "item" | "event" | "analysis_task";
export type AnalysisTaskLinkedSubjectType = "saved_view" | "item" | "event";
export type AnalysisTaskPriority = "low" | "normal" | "high" | "urgent";

export interface AnalysisUserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

export interface AnalysisQueryState {
  queryString: string;
}

export interface SavedAnalysisView {
  id: string;
  title: string;
  description?: string | null;
  surface: SavedAnalysisSurface;
  routePath: string;
  queryState: AnalysisQueryState;
  visibility: SavedAnalysisVisibility;
  createdAt: string;
  updatedAt: string;
  createdBy: AnalysisUserSummary;
  updatedBy: AnalysisUserSummary;
  canEdit: boolean;
}

export interface AnalysisComment {
  id: string;
  createdById: string;
  bodyMarkdown: string;
  createdAt: string;
  updatedAt: string;
  createdBy: AnalysisUserSummary;
}

export interface AnalysisThread {
  id: string;
  subjectType: AnalysisSubjectType;
  subjectId: string;
  noteMarkdown?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: AnalysisUserSummary;
  updatedBy: AnalysisUserSummary;
  comments: AnalysisComment[];
}

export interface AnalysisBoardSummary {
  id: string;
  title: string;
  description?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: AnalysisUserSummary;
  updatedBy: AnalysisUserSummary;
  columnCount: number;
  taskCount: number;
}

export interface AnalysisTaskCard {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  bodyMarkdown?: string | null;
  priority: AnalysisTaskPriority;
  assigneeId?: string | null;
  assignee?: AnalysisUserSummary | null;
  linkedSubjectType?: AnalysisTaskLinkedSubjectType | null;
  linkedSubjectId?: string | null;
  dueAt?: string | null;
  sortOrder: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: AnalysisUserSummary;
  updatedBy: AnalysisUserSummary;
}

export interface AnalysisBoardColumn {
  id: string;
  title: string;
  color?: string | null;
  sortOrder: number;
  isDone: boolean;
  createdAt: string;
  updatedAt: string;
  tasks: AnalysisTaskCard[];
}

export interface AnalysisBoardDetail {
  id: string;
  title: string;
  description?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: AnalysisUserSummary;
  updatedBy: AnalysisUserSummary;
  columns: AnalysisBoardColumn[];
}

export interface AnalysisMemberSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

export function sanitizeAnalysisQueryString(
  input?: string | URLSearchParams | { toString(): string } | null,
) {
  const raw =
    typeof input === "string"
      ? input
      : input && typeof input.toString === "function"
        ? input.toString()
        : "";
  const params = new URLSearchParams(raw.replace(/^\?+/, "").trim());
  params.delete("savedView");
  params.delete("page");
  params.delete("pageSize");
  return params.toString();
}

export function buildSavedViewHref(view: Pick<
  SavedAnalysisView,
  "id" | "routePath" | "queryState"
>) {
  const query = new URLSearchParams(sanitizeAnalysisQueryString(view.queryState.queryString));
  query.set("savedView", view.id);
  const serialized = query.toString();
  return serialized ? `${view.routePath}?${serialized}` : `${view.routePath}?savedView=${view.id}`;
}

export function buildSavedViewPath(
  pathname: string,
  queryString: string,
  savedViewId: string,
) {
  const params = new URLSearchParams(sanitizeAnalysisQueryString(queryString));
  params.set("savedView", savedViewId);
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : `${pathname}?savedView=${savedViewId}`;
}

export function formatAnalysisActorName(actor: AnalysisUserSummary) {
  const displayName = [actor.firstName, actor.lastName]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(" ");
  return displayName || actor.email;
}

export function buildAnalysisSubjectHref(
  subjectType?: AnalysisTaskLinkedSubjectType | null,
  subjectId?: string | null,
) {
  if (!subjectType || !subjectId) {
    return null;
  }
  if (subjectType === "saved_view") {
    return `/analysis?savedView=${encodeURIComponent(subjectId)}`;
  }
  if (subjectType === "item") {
    return `/items/${encodeURIComponent(subjectId)}`;
  }
  return `/events/${encodeURIComponent(subjectId)}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}
