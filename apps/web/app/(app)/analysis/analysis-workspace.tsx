"use client";

import {
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Button,
  Checkbox,
  DatePicker,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnnotationPanel } from "@/components/analysis/annotation-panel";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { PageHeader } from "@/components/page-header";
import {
  buildAnalysisSubjectHref,
  formatAnalysisActorName,
  type AnalysisBoardColumn,
  type AnalysisBoardDetail,
  type AnalysisBoardSummary,
  type AnalysisMemberSummary,
  type AnalysisTaskCard,
  type AnalysisTaskLinkedSubjectType,
  type AnalysisTaskPriority,
} from "@/lib/analysis-workspace";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { AnalysisLibrary } from "./analysis-library";

interface RbacMemberRow {
  isActive?: boolean;
  user: AnalysisMemberSummary & { isActive?: boolean };
}

interface TaskFormValues {
  title: string;
  bodyMarkdown?: string;
  priority: AnalysisTaskPriority;
  columnId?: string;
  assigneeId?: string | null;
  linkedSubjectType?: AnalysisTaskLinkedSubjectType | null;
  linkedSubjectId?: string | null;
  dueAt?: dayjs.Dayjs | null;
}

interface BoardFormValues {
  title: string;
  description?: string;
}

interface ColumnFormValues {
  title: string;
  color?: string;
  isDone?: boolean;
}

const PRIORITY_COLORS: Record<AnalysisTaskPriority, string> = {
  low: "default",
  normal: "blue",
  high: "orange",
  urgent: "red",
};

function priorityColor(priority: AnalysisTaskPriority) {
  return PRIORITY_COLORS[priority] ?? "default";
}

function memberOptions(members: AnalysisMemberSummary[]) {
  return members.map((member) => ({
    value: member.id,
    label: formatAnalysisActorName(member),
  }));
}

function toTaskPayload(values: TaskFormValues) {
  const linkedSubjectType = values.linkedSubjectType ?? null;
  const linkedSubjectId = values.linkedSubjectId?.trim() || null;
  return {
    title: values.title.trim(),
    bodyMarkdown: values.bodyMarkdown?.trim() || undefined,
    priority: values.priority,
    columnId: values.columnId,
    assigneeId: values.assigneeId || null,
    linkedSubjectType: linkedSubjectType && linkedSubjectId ? linkedSubjectType : null,
    linkedSubjectId: linkedSubjectType && linkedSubjectId ? linkedSubjectId : null,
    dueAt: values.dueAt ? values.dueAt.toISOString() : null,
  };
}

function SortableTaskCard({
  task,
  locale,
  onOpen,
}: {
  task: AnalysisTaskCard;
  locale: ReturnType<typeof resolveLocale>;
  onOpen: (task: AnalysisTaskCard) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const linkedHref = buildAnalysisSubjectHref(task.linkedSubjectType, task.linkedSubjectId);
  const priorityLabels: Record<AnalysisTaskPriority, string> = {
    low: t("analysis.workspace.priority.low"),
    normal: t("analysis.workspace.priority.normal"),
    high: t("analysis.workspace.priority.high"),
    urgent: t("analysis.workspace.priority.urgent"),
  };
  const subjectLabels: Record<AnalysisTaskLinkedSubjectType, string> = {
    saved_view: t("analysis.workspace.subject.savedView"),
    item: t("analysis.workspace.subject.item"),
    event: t("analysis.workspace.subject.event"),
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm ${
        isDragging ? "opacity-70" : ""
      }`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-2">
        <Typography.Text strong className="min-w-0">
          {task.title}
        </Typography.Text>
        <Button
          size="small"
          type="text"
          icon={<EditOutlined />}
          aria-label={t("common.edit")}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(task);
          }}
        />
      </div>
      {task.bodyMarkdown ? (
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} className="mb-2 mt-1.5 text-xs">
          {task.bodyMarkdown}
        </Typography.Paragraph>
      ) : null}
      <Space wrap size={[6, 6]}>
        <Tag color={priorityColor(task.priority)}>{priorityLabels[task.priority]}</Tag>
        {task.assignee ? (
          <Tag icon={<UserOutlined />}>{formatAnalysisActorName(task.assignee)}</Tag>
        ) : null}
        {task.dueAt ? (
          <Tag icon={<ClockCircleOutlined />}>
            {formatDateTime(task.dueAt, locale, { dateStyle: "medium" })}
          </Tag>
        ) : null}
        {task.commentCount > 0 ? (
          <Tag icon={<MessageOutlined />}>{task.commentCount}</Tag>
        ) : null}
        {linkedHref ? (
          <Link href={linkedHref} onClick={(event) => event.stopPropagation()}>
            <Tag color="geekblue">
              {task.linkedSubjectType ? subjectLabels[task.linkedSubjectType] : null}
            </Tag>
          </Link>
        ) : null}
      </Space>
    </div>
  );
}

function BoardColumnView({
  column,
  locale,
  onCreateTask,
  onOpenTask,
}: {
  column: AnalysisBoardColumn;
  locale: ReturnType<typeof resolveLocale>;
  onCreateTask: (columnId: string) => void;
  onOpenTask: (task: AnalysisTaskCard) => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });

  return (
    <section
      ref={setNodeRef}
      className={`flex md:min-h-viz-2xl w-full md:w-[320px] shrink-0 flex-col rounded-md border border-[var(--border)] bg-slate-50 dark:bg-slate-800 ${
        isOver ? "ring-2 ring-blue-300 dark:ring-blue-500" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <Space size={6}>
          <Typography.Text strong>{column.title}</Typography.Text>
          <Tag color={column.color ?? "default"}>{column.tasks.length}</Tag>
        </Space>
        <Tooltip title={t("analysis.workspace.addTask")}>
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            aria-label={t("analysis.workspace.addTask")}
            onClick={() => onCreateTask(column.id)}
          />
        </Tooltip>
      </div>
      <SortableContext
        items={column.tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
          {column.tasks.length ? (
            column.tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                locale={locale}
                onOpen={onOpenTask}
              />
            ))
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <ChartEmptyState
                presentation="banner"
                description={t("analysis.workspace.emptyColumn")}
                className="w-full"
              />
            </div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

export function AnalysisWorkspace() {
  const { t, i18n } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [boardForm] = Form.useForm<BoardFormValues>();
  const [taskForm] = Form.useForm<TaskFormValues>();
  const [editTaskForm] = Form.useForm<TaskFormValues>();
  const [columnForm] = Form.useForm<ColumnFormValues>();
  const [columnEditForm] = Form.useForm<ColumnFormValues>();
  const [boards, setBoards] = useState<AnalysisBoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [board, setBoard] = useState<AnalysisBoardDetail | null>(null);
  const [members, setMembers] = useState<AnalysisMemberSummary[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [boardModalOpen, setBoardModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskColumnId, setTaskColumnId] = useState<string | null>(null);
  const [columnsModalOpen, setColumnsModalOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<AnalysisBoardColumn | null>(null);
  const [editingTask, setEditingTask] = useState<AnalysisTaskCard | null>(null);
  const accessToken = session?.accessToken;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canWrite = permissions.includes("analysis.write");
  const canReadUsers = permissions.includes("users.read");
  const locale = resolveLocale(i18n.language);
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const loadBoards = useCallback(async () => {
    if (!accessToken) {
      return;
    }
    try {
      setLoadingBoards(true);
      const response = await apiClient.get<AnalysisBoardSummary[]>("analysis/boards");
      setBoards(response.data);
      setActiveBoardId((current) =>
        current && response.data.some((entry) => entry.id === current)
          ? current
          : response.data[0]?.id ?? null,
      );
    } catch (error) {
      captureClientError("Failed to load analysis boards", error);
      messageApi.error(t("analysis.workspace.messages.loadBoardsFailed"));
    } finally {
      setLoadingBoards(false);
    }
  }, [accessToken, apiClient, messageApi, t]);

  const loadBoard = useCallback(
    async (boardId: string) => {
      try {
        setLoadingBoard(true);
        const response = await apiClient.get<AnalysisBoardDetail>(
          `analysis/boards/${boardId}`,
        );
        setBoard(response.data);
      } catch (error) {
        captureClientError("Failed to load analysis board", error);
        messageApi.error(t("analysis.workspace.messages.loadBoardFailed"));
      } finally {
        setLoadingBoard(false);
      }
    },
    [apiClient, messageApi, t],
  );

  const loadMembers = useCallback(async () => {
    if (!accessToken || !canReadUsers) {
      return;
    }
    try {
      const response = await apiClient.get<RbacMemberRow[]>("rbac/members");
      setMembers(
        response.data
          .filter((entry) => entry.isActive !== false && entry.user.isActive !== false)
          .map((entry) => entry.user),
      );
    } catch (error) {
      captureClientError("Failed to load analysis assignees", error);
      setMembers([]);
    }
  }, [accessToken, apiClient, canReadUsers]);

  useEffect(() => {
    void loadBoards();
    void loadMembers();
  }, [loadBoards, loadMembers]);

  useEffect(() => {
    if (activeBoardId) {
      void loadBoard(activeBoardId);
    } else {
      setBoard(null);
    }
  }, [activeBoardId, loadBoard]);

  useEffect(() => {
    if (!editingTask) {
      editTaskForm.resetFields();
      return;
    }
    editTaskForm.setFieldsValue({
      title: editingTask.title,
      bodyMarkdown: editingTask.bodyMarkdown ?? undefined,
      priority: editingTask.priority,
      columnId: editingTask.columnId,
      assigneeId: editingTask.assigneeId ?? null,
      linkedSubjectType: editingTask.linkedSubjectType ?? null,
      linkedSubjectId: editingTask.linkedSubjectId ?? null,
      dueAt: editingTask.dueAt ? dayjs(editingTask.dueAt) : null,
    });
  }, [editTaskForm, editingTask]);

  useEffect(() => {
    if (!editingColumn) {
      columnEditForm.resetFields();
      return;
    }
    columnEditForm.setFieldsValue({
      title: editingColumn.title,
      color: editingColumn.color ?? undefined,
      isDone: editingColumn.isDone,
    });
  }, [columnEditForm, editingColumn]);

  const findTaskColumnId = useCallback(
    (taskId: string) =>
      board?.columns.find((column) => column.tasks.some((task) => task.id === taskId))?.id ??
      null,
    [board],
  );

  const handleCreateBoard = useCallback(async () => {
    try {
      const values = await boardForm.validateFields();
      setSaving(true);
      const response = await apiClient.post<AnalysisBoardDetail>("analysis/boards", {
        title: values.title.trim(),
        description: values.description?.trim() || undefined,
      });
      setBoardModalOpen(false);
      boardForm.resetFields();
      await loadBoards();
      setActiveBoardId(response.data.id);
      messageApi.success(t("analysis.workspace.messages.boardCreated"));
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis board", error);
      messageApi.error(t("analysis.workspace.messages.boardCreateFailed"));
    } finally {
      setSaving(false);
    }
  }, [apiClient, boardForm, loadBoards, messageApi, t]);

  const openCreateTask = useCallback(
    (columnId?: string) => {
      const targetColumnId = columnId ?? board?.columns[0]?.id ?? null;
      setTaskColumnId(targetColumnId);
      taskForm.setFieldsValue({
        priority: "normal",
        columnId: targetColumnId ?? undefined,
        assigneeId: null,
        linkedSubjectType: null,
        linkedSubjectId: null,
        dueAt: null,
      });
      setTaskModalOpen(true);
    },
    [board?.columns, taskForm],
  );

  const handleCreateTask = useCallback(async () => {
    if (!activeBoardId) {
      return;
    }
    try {
      const values = await taskForm.validateFields();
      setSaving(true);
      await apiClient.post(`analysis/boards/${activeBoardId}/tasks`, {
        ...toTaskPayload(values),
        columnId: values.columnId ?? taskColumnId ?? undefined,
      });
      setTaskModalOpen(false);
      taskForm.resetFields();
      await loadBoard(activeBoardId);
      await loadBoards();
      messageApi.success(t("analysis.workspace.messages.taskCreated"));
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis task", error);
      messageApi.error(t("analysis.workspace.messages.taskCreateFailed"));
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, loadBoard, loadBoards, messageApi, taskColumnId, taskForm, t]);

  const handleUpdateTask = useCallback(async () => {
    if (!editingTask || !activeBoardId) {
      return;
    }
    try {
      const values = await editTaskForm.validateFields();
      setSaving(true);
      const nextColumnId = values.columnId ?? editingTask.columnId;
      const payload = toTaskPayload(values);
      await apiClient.patch(`analysis/tasks/${editingTask.id}`, {
        title: payload.title,
        bodyMarkdown: payload.bodyMarkdown ?? null,
        priority: payload.priority,
        assigneeId: payload.assigneeId,
        linkedSubjectType: payload.linkedSubjectType,
        linkedSubjectId: payload.linkedSubjectId,
        dueAt: payload.dueAt,
      });
      if (nextColumnId !== editingTask.columnId) {
        await apiClient.post(`analysis/tasks/${editingTask.id}/move`, {
          targetColumnId: nextColumnId,
          targetIndex: 0,
        });
      }
      await loadBoard(activeBoardId);
      await loadBoards();
      messageApi.success(t("analysis.workspace.messages.taskUpdated"));
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to update analysis task", error);
      messageApi.error(t("analysis.workspace.messages.taskUpdateFailed"));
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, editTaskForm, editingTask, loadBoard, loadBoards, messageApi, t]);

  const handleDeleteTask = useCallback(async () => {
    if (!editingTask || !activeBoardId) {
      return;
    }
    try {
      setSaving(true);
      await apiClient.delete(`analysis/tasks/${editingTask.id}`);
      setEditingTask(null);
      await loadBoard(activeBoardId);
      await loadBoards();
      messageApi.success(t("analysis.workspace.messages.taskDeleted"));
    } catch (error) {
      captureClientError("Failed to delete analysis task", error);
      messageApi.error(t("analysis.workspace.messages.taskDeleteFailed"));
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, editingTask, loadBoard, loadBoards, messageApi, t]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!board || !activeBoardId || !event.over) {
        return;
      }
      const taskId = String(event.active.id);
      const overId = String(event.over.id);
      const sourceColumnId = findTaskColumnId(taskId);
      const targetColumnId = overId.startsWith("column:")
        ? overId.slice("column:".length)
        : findTaskColumnId(overId);
      if (!sourceColumnId || !targetColumnId) {
        return;
      }
      const targetColumn = board.columns.find((column) => column.id === targetColumnId);
      if (!targetColumn) {
        return;
      }
      const overTaskIndex = targetColumn.tasks.findIndex((task) => task.id === overId);
      const targetIndex = overTaskIndex >= 0 ? overTaskIndex : targetColumn.tasks.length;
      try {
        await apiClient.post(`analysis/tasks/${taskId}/move`, {
          targetColumnId,
          targetIndex,
        });
        await loadBoard(activeBoardId);
        await loadBoards();
      } catch (error) {
        captureClientError("Failed to move analysis task", error);
        messageApi.error(t("analysis.workspace.messages.taskMoveFailed"));
      }
    },
    [activeBoardId, apiClient, board, findTaskColumnId, loadBoard, loadBoards, messageApi, t],
  );

  const handleCreateColumn = useCallback(async () => {
    if (!activeBoardId) {
      return;
    }
    try {
      const values = await columnForm.validateFields();
      setSaving(true);
      await apiClient.post(`analysis/boards/${activeBoardId}/columns`, {
        title: values.title.trim(),
        color: values.color?.trim() || undefined,
        isDone: values.isDone ?? false,
      });
      columnForm.resetFields();
      await loadBoard(activeBoardId);
      await loadBoards();
      messageApi.success(t("analysis.workspace.messages.columnAdded"));
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis column", error);
      messageApi.error(t("analysis.workspace.messages.columnAddFailed"));
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, columnForm, loadBoard, loadBoards, messageApi, t]);

  const handleUpdateColumn = useCallback(async () => {
    if (!editingColumn || !activeBoardId) {
      return;
    }
    try {
      const values = await columnEditForm.validateFields();
      setSaving(true);
      await apiClient.patch(`analysis/columns/${editingColumn.id}`, {
        title: values.title.trim(),
        color: values.color?.trim() || null,
        isDone: values.isDone ?? false,
      });
      setEditingColumn(null);
      await loadBoard(activeBoardId);
      await loadBoards();
      messageApi.success(t("analysis.workspace.messages.columnUpdated"));
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to update analysis column", error);
      messageApi.error(t("analysis.workspace.messages.columnUpdateFailed"));
    } finally {
      setSaving(false);
    }
  }, [
    activeBoardId,
    apiClient,
    columnEditForm,
    editingColumn,
    loadBoard,
    loadBoards,
    messageApi,
    t,
  ]);

  const moveColumn = useCallback(
    async (columnId: string, direction: -1 | 1) => {
      if (!board || !activeBoardId) {
        return;
      }
      const ids = board.columns.map((column) => column.id);
      const index = ids.indexOf(columnId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) {
        return;
      }
      const nextIds = [...ids];
      const [id] = nextIds.splice(index, 1);
      nextIds.splice(targetIndex, 0, id!);
      try {
        await apiClient.post(`analysis/boards/${activeBoardId}/columns/reorder`, {
          columnIds: nextIds,
        });
        await loadBoard(activeBoardId);
      } catch (error) {
        captureClientError("Failed to reorder analysis columns", error);
        messageApi.error(t("analysis.workspace.messages.columnReorderFailed"));
      }
    },
    [activeBoardId, apiClient, board, loadBoard, messageApi, t],
  );

  const deleteColumn = useCallback(
    async (columnId: string) => {
      if (!board || !activeBoardId) {
        return;
      }
      const target = board.columns.find((column) => column.id !== columnId);
      if (!target) {
        messageApi.error(t("analysis.workspace.messages.cannotDeleteLastColumn"));
        return;
      }
      try {
        await apiClient.delete(`analysis/columns/${columnId}`, {
          data: { moveCardsToColumnId: target.id },
        });
        await loadBoard(activeBoardId);
        await loadBoards();
        messageApi.success(t("analysis.workspace.messages.columnDeleted"));
      } catch (error) {
        captureClientError("Failed to delete analysis column", error);
        messageApi.error(t("analysis.workspace.messages.columnDeleteFailed"));
      }
    },
    [activeBoardId, apiClient, board, loadBoard, loadBoards, messageApi, t],
  );

  const archiveBoard = useCallback(async () => {
    if (!activeBoardId) {
      return;
    }
    try {
      await apiClient.delete(`analysis/boards/${activeBoardId}`);
      setActiveBoardId(null);
      setBoard(null);
      await loadBoards();
      messageApi.success(t("analysis.workspace.messages.boardArchived"));
    } catch (error) {
      captureClientError("Failed to archive analysis board", error);
      messageApi.error(t("analysis.workspace.messages.boardArchiveFailed"));
    }
  }, [activeBoardId, apiClient, loadBoards, messageApi, t]);

  const boardOptions = boards.map((entry) => ({
    value: entry.id,
    label: entry.title,
  }));
  const activeBoard = boards.find((entry) => entry.id === activeBoardId);

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <PageHeader
        kicker={t("nav.groups.research")}
        title={t("analysis.workspace.title")}
        description={t("analysis.workspace.subtitle")}
        actions={
          <>
            <Select
              className="w-full sm:w-[220px]"
              value={activeBoardId ?? undefined}
              loading={loadingBoards}
              onChange={setActiveBoardId}
              options={boardOptions}
              placeholder={t("analysis.workspace.selectBoard")}
            />
            <Button icon={<ReloadOutlined />} onClick={() => activeBoardId && loadBoard(activeBoardId)}>
              {t("common.refresh")}
            </Button>
            <Button icon={<PlusOutlined />} disabled={!canWrite} onClick={() => setBoardModalOpen(true)}>
              {t("analysis.workspace.newBoard")}
            </Button>
          </>
        }
      />

      <Tabs
        defaultActiveKey="board"
        items={[
          {
            key: "board",
            label: t("analysis.workspace.boardTab"),
            children: (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 lg:flex-row lg:items-center lg:justify-between">
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{activeBoard?.title ?? t("analysis.workspace.boardFallback")}</Typography.Text>
                    <Typography.Text type="secondary">
                      {activeBoard?.description || t("analysis.workspace.boardDescriptionFallback")}
                    </Typography.Text>
                  </Space>
                  <Space wrap>
                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      disabled={!canWrite || !board?.columns.length}
                      onClick={() => openCreateTask()}
                    >
                      {t("analysis.workspace.newTask")}
                    </Button>
                    <Button
                      icon={<SettingOutlined />}
                      disabled={!canWrite || !board}
                      onClick={() => setColumnsModalOpen(true)}
                    >
                      {t("analysis.workspace.manageColumns")}
                    </Button>
                    <Popconfirm title={t("analysis.workspace.archiveConfirm")} onConfirm={archiveBoard}>
                      <Button danger icon={<DeleteOutlined />} disabled={!canWrite || boards.length <= 1}>
                        {t("analysis.workspace.archive")}
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>

                <Spin spinning={loadingBoard}>
                  {board?.columns.length ? (
                    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                      <div className="flex flex-col gap-3 md:flex-row md:overflow-x-auto pb-3">
                        {board.columns.map((column) => (
                          <BoardColumnView
                            key={column.id}
                            column={column}
                            locale={locale}
                            onCreateTask={openCreateTask}
                            onOpenTask={setEditingTask}
                          />
                        ))}
                      </div>
                    </DndContext>
                  ) : (
                    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-10">
                      <ChartEmptyState
                        presentation="banner"
                        description={t("analysis.workspace.emptyBoard")}
                      />
                    </div>
                  )}
                </Spin>
              </div>
            ),
          },
          {
            key: "saved",
            label: t("analysis.workspace.savedViewsTab"),
            children: <AnalysisLibrary />,
          },
        ]}
      />

      <Modal
        open={boardModalOpen}
        title={t("analysis.workspace.createBoard")}
        onOk={() => void handleCreateBoard()}
        confirmLoading={saving}
        onCancel={() => setBoardModalOpen(false)}
      >
        <Form form={boardForm} layout="vertical">
          <Form.Item
            name="title"
            label={t("analysis.workspace.fields.title")}
            rules={[{ required: true, message: t("analysis.workspace.validation.titleRequired") }]}
          >
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="description" label={t("analysis.workspace.fields.description")}>
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={taskModalOpen}
        title={t("analysis.workspace.createTask")}
        onOk={() => void handleCreateTask()}
        confirmLoading={saving}
        onCancel={() => setTaskModalOpen(false)}
      >
        <TaskForm form={taskForm} board={board} members={members} />
      </Modal>

      <Modal
        open={columnsModalOpen}
        title={t("analysis.workspace.manageColumns")}
        width="min(720px, calc(100vw - 32px))"
        footer={null}
        onCancel={() => setColumnsModalOpen(false)}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {board?.columns.map((column, index) => (
            <div
              key={column.id}
              className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3 lg:flex-row lg:items-center lg:justify-between"
            >
              <Space wrap>
                <Tag color={column.color ?? "default"}>{column.title}</Tag>
                {column.isDone ? <Tag color="green">{t("analysis.workspace.columnDone")}</Tag> : null}
                <Typography.Text type="secondary">
                  {t("analysis.workspace.tasksCount", { count: column.tasks.length })}
                </Typography.Text>
              </Space>
              <Space wrap>
                <Button size="small" disabled={index === 0} onClick={() => void moveColumn(column.id, -1)}>
                  {t("analysis.workspace.moveUp")}
                </Button>
                <Button
                  size="small"
                  disabled={index === (board?.columns.length ?? 1) - 1}
                  onClick={() => void moveColumn(column.id, 1)}
                >
                  {t("analysis.workspace.moveDown")}
                </Button>
                <Button size="small" onClick={() => setEditingColumn(column)}>
                  {t("analysis.workspace.edit")}
                </Button>
                <Popconfirm
                  title={t("analysis.workspace.deleteColumnConfirm")}
                  description={t("analysis.workspace.deleteColumnDescription")}
                  onConfirm={() => void deleteColumn(column.id)}
                >
                  <Button size="small" danger disabled={(board?.columns.length ?? 0) <= 1}>
                    {t("common.delete")}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          ))}
          <Form form={columnForm} layout="inline">
            <Form.Item
              name="title"
              rules={[{ required: true, message: t("analysis.workspace.validation.titleRequired") }]}
            >
              <Input placeholder={t("analysis.workspace.columnTitlePlaceholder")} maxLength={80} />
            </Form.Item>
            <Form.Item name="color">
              <Input placeholder={t("analysis.workspace.color")} maxLength={32} />
            </Form.Item>
            <Form.Item name="isDone" valuePropName="checked">
              <Checkbox>{t("analysis.workspace.columnDone")}</Checkbox>
            </Form.Item>
            <Form.Item>
              <Button type="primary" loading={saving} onClick={() => void handleCreateColumn()}>
                {t("analysis.workspace.addColumn")}
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Modal>

      <Modal
        open={Boolean(editingColumn)}
        title={t("analysis.workspace.editColumn")}
        onOk={() => void handleUpdateColumn()}
        confirmLoading={saving}
        onCancel={() => setEditingColumn(null)}
      >
        <Form form={columnEditForm} layout="vertical">
          <Form.Item
            name="title"
            label={t("analysis.workspace.fields.title")}
            rules={[{ required: true, message: t("analysis.workspace.validation.titleRequired") }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="color" label={t("analysis.workspace.color")}>
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="isDone" valuePropName="checked">
            <Checkbox>{t("analysis.workspace.columnDone")}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={Boolean(editingTask)}
        title={editingTask?.title ?? t("analysis.workspace.taskFallback")}
        width="min(720px, 100vw)"
        onClose={() => setEditingTask(null)}
        extra={
          <Space>
            <Popconfirm title={t("analysis.workspace.deleteTaskConfirm")} onConfirm={() => void handleDeleteTask()}>
              <Button danger icon={<DeleteOutlined />} disabled={!canWrite}>
                {t("common.delete")}
              </Button>
            </Popconfirm>
            <Button type="primary" loading={saving} disabled={!canWrite} onClick={() => void handleUpdateTask()}>
              {t("common.save")}
            </Button>
          </Space>
        }
      >
        {editingTask ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <TaskForm form={editTaskForm} board={board} members={members} />
            <AnnotationPanel
              subjectType="analysis_task"
              subjectId={editingTask.id}
              title={t("analysis.workspace.taskDiscussion")}
            />
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}

function TaskForm({
  form,
  board,
  members,
}: {
  form: ReturnType<typeof Form.useForm<TaskFormValues>>[0];
  board: AnalysisBoardDetail | null;
  members: AnalysisMemberSummary[];
}) {
  const { t } = useTranslation();
  const priorityOptions = [
    { value: "low", label: t("analysis.workspace.priority.low") },
    { value: "normal", label: t("analysis.workspace.priority.normal") },
    { value: "high", label: t("analysis.workspace.priority.high") },
    { value: "urgent", label: t("analysis.workspace.priority.urgent") },
  ];
  const subjectOptions = [
    { value: "saved_view", label: t("analysis.workspace.subject.savedView") },
    { value: "item", label: t("analysis.workspace.subject.item") },
    { value: "event", label: t("analysis.workspace.subject.event") },
  ];

  return (
    <Form form={form} layout="vertical" initialValues={{ priority: "normal" }}>
      <Form.Item
        name="title"
        label={t("analysis.workspace.fields.title")}
        rules={[{ required: true, message: t("analysis.workspace.validation.titleRequired") }]}
      >
        <Input maxLength={160} />
      </Form.Item>
      <Form.Item name="bodyMarkdown" label={t("analysis.workspace.fields.details")}>
        <Input.TextArea rows={4} maxLength={10000} />
      </Form.Item>
      <div className="grid gap-3 md:grid-cols-2">
        <Form.Item name="columnId" label={t("analysis.workspace.fields.column")}>
          <Select
            options={board?.columns.map((column) => ({
              value: column.id,
              label: column.title,
            }))}
          />
        </Form.Item>
        <Form.Item name="priority" label={t("analysis.workspace.fields.priority")}>
          <Select options={priorityOptions} />
        </Form.Item>
        <Form.Item name="assigneeId" label={t("analysis.workspace.fields.assignee")}>
          <Select allowClear options={memberOptions(members)} />
        </Form.Item>
        <Form.Item name="dueAt" label={t("analysis.workspace.fields.dueDate")}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="linkedSubjectType" label={t("analysis.workspace.fields.linkedSubject")}>
          <Select allowClear options={subjectOptions} />
        </Form.Item>
        <Form.Item name="linkedSubjectId" label={t("analysis.workspace.fields.subjectId")}>
          <Input maxLength={191} prefix={<FolderOpenOutlined />} />
        </Form.Item>
      </div>
    </Form>
  );
}
