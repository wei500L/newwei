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
  Avatar,
  Button,
  Checkbox,
  DatePicker,
  Drawer,
  Empty,
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
import { createApiClient } from "@/lib/api-client";
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

const PRIORITY_OPTIONS: Array<{ value: AnalysisTaskPriority; label: string; color: string }> = [
  { value: "low", label: "Low", color: "default" },
  { value: "normal", label: "Normal", color: "blue" },
  { value: "high", label: "High", color: "orange" },
  { value: "urgent", label: "Urgent", color: "red" },
];

const SUBJECT_OPTIONS: Array<{ value: AnalysisTaskLinkedSubjectType; label: string }> = [
  { value: "saved_view", label: "Saved view" },
  { value: "item", label: "Item" },
  { value: "event", label: "Event" },
];

function priorityColor(priority: AnalysisTaskPriority) {
  return PRIORITY_OPTIONS.find((option) => option.value === priority)?.color ?? "default";
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const linkedHref = buildAnalysisSubjectHref(task.linkedSubjectType, task.linkedSubjectId);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-md border border-[var(--border)] bg-white p-3 shadow-sm ${
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
          onClick={(event) => {
            event.stopPropagation();
            onOpen(task);
          }}
        />
      </div>
      {task.bodyMarkdown ? (
        <Typography.Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 8, marginTop: 6, fontSize: 12 }}
        >
          {task.bodyMarkdown}
        </Typography.Paragraph>
      ) : null}
      <Space wrap size={[6, 6]}>
        <Tag color={priorityColor(task.priority)}>{task.priority}</Tag>
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
            <Tag color="geekblue">{task.linkedSubjectType}</Tag>
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
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });

  return (
    <section
      ref={setNodeRef}
      className={`flex min-h-[420px] w-[320px] shrink-0 flex-col rounded-md border border-[var(--border)] bg-slate-50 ${
        isOver ? "ring-2 ring-blue-300" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <Space size={6}>
          <Typography.Text strong>{column.title}</Typography.Text>
          <Tag color={column.color ?? "default"}>{column.tasks.length}</Tag>
        </Space>
        <Tooltip title="Add task">
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
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
            <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-white/60 p-4">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tasks" />
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
      messageApi.error("Failed to load analysis boards.");
    } finally {
      setLoadingBoards(false);
    }
  }, [accessToken, apiClient, messageApi]);

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
        messageApi.error("Failed to load analysis board.");
      } finally {
        setLoadingBoard(false);
      }
    },
    [apiClient, messageApi],
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

  const allTasks = useMemo(
    () => board?.columns.flatMap((column) => column.tasks) ?? [],
    [board],
  );

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
      messageApi.success("Analysis board created.");
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis board", error);
      messageApi.error("Failed to create analysis board.");
    } finally {
      setSaving(false);
    }
  }, [apiClient, boardForm, loadBoards, messageApi]);

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
      messageApi.success("Task created.");
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis task", error);
      messageApi.error("Failed to create task.");
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, loadBoard, loadBoards, messageApi, taskColumnId, taskForm]);

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
      messageApi.success("Task updated.");
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to update analysis task", error);
      messageApi.error("Failed to update task.");
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, editTaskForm, editingTask, loadBoard, loadBoards, messageApi]);

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
      messageApi.success("Task deleted.");
    } catch (error) {
      captureClientError("Failed to delete analysis task", error);
      messageApi.error("Failed to delete task.");
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, editingTask, loadBoard, loadBoards, messageApi]);

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
        messageApi.error("Failed to move task.");
      }
    },
    [activeBoardId, apiClient, board, findTaskColumnId, loadBoard, loadBoards, messageApi],
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
      messageApi.success("Column added.");
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis column", error);
      messageApi.error("Failed to add column.");
    } finally {
      setSaving(false);
    }
  }, [activeBoardId, apiClient, columnForm, loadBoard, loadBoards, messageApi]);

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
      messageApi.success("Column updated.");
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to update analysis column", error);
      messageApi.error("Failed to update column.");
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
        messageApi.error("Failed to reorder columns.");
      }
    },
    [activeBoardId, apiClient, board, loadBoard, messageApi],
  );

  const deleteColumn = useCallback(
    async (columnId: string) => {
      if (!board || !activeBoardId) {
        return;
      }
      const target = board.columns.find((column) => column.id !== columnId);
      if (!target) {
        messageApi.error("Cannot delete the last column.");
        return;
      }
      try {
        await apiClient.delete(`analysis/columns/${columnId}`, {
          data: { moveCardsToColumnId: target.id },
        });
        await loadBoard(activeBoardId);
        await loadBoards();
        messageApi.success("Column deleted.");
      } catch (error) {
        captureClientError("Failed to delete analysis column", error);
        messageApi.error("Failed to delete column.");
      }
    },
    [activeBoardId, apiClient, board, loadBoard, loadBoards, messageApi],
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
      messageApi.success("Board archived.");
    } catch (error) {
      captureClientError("Failed to archive analysis board", error);
      messageApi.error("Failed to archive board.");
    }
  }, [activeBoardId, apiClient, loadBoards, messageApi]);

  const boardOptions = boards.map((entry) => ({
    value: entry.id,
    label: entry.title,
  }));
  const activeBoard = boards.find((entry) => entry.id === activeBoardId);

  return (
    <div className="flex flex-col gap-4">
      {contextHolder}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Space direction="vertical" size={2}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t("analysis.workspace.title")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("analysis.workspace.subtitle")}
          </Typography.Text>
        </Space>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            value={activeBoardId ?? undefined}
            loading={loadingBoards}
            onChange={setActiveBoardId}
            options={boardOptions}
            placeholder="Select board"
          />
          <Button icon={<ReloadOutlined />} onClick={() => activeBoardId && loadBoard(activeBoardId)}>
            Refresh
          </Button>
          <Button icon={<PlusOutlined />} disabled={!canWrite} onClick={() => setBoardModalOpen(true)}>
            New board
          </Button>
        </Space>
      </div>

      <Tabs
        defaultActiveKey="board"
        items={[
          {
            key: "board",
            label: "Board",
            children: (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-white p-4 lg:flex-row lg:items-center lg:justify-between">
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{activeBoard?.title ?? "Board"}</Typography.Text>
                    <Typography.Text type="secondary">
                      {activeBoard?.description || "Org-shared task board for analysis work."}
                    </Typography.Text>
                  </Space>
                  <Space wrap>
                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      disabled={!canWrite || !board?.columns.length}
                      onClick={() => openCreateTask()}
                    >
                      New task
                    </Button>
                    <Button
                      icon={<SettingOutlined />}
                      disabled={!canWrite || !board}
                      onClick={() => setColumnsModalOpen(true)}
                    >
                      Manage columns
                    </Button>
                    <Popconfirm title="Archive this board?" onConfirm={archiveBoard}>
                      <Button danger icon={<DeleteOutlined />} disabled={!canWrite || boards.length <= 1}>
                        Archive
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>

                <Spin spinning={loadingBoard}>
                  {board?.columns.length ? (
                    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                      <div className="flex gap-3 overflow-x-auto pb-3">
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
                    <div className="rounded-md border border-[var(--border)] bg-white p-10">
                      <Empty description="No board columns yet." />
                    </div>
                  )}
                </Spin>
              </div>
            ),
          },
          {
            key: "saved",
            label: "Saved views",
            children: <AnalysisLibrary />,
          },
        ]}
      />

      <Modal
        open={boardModalOpen}
        title="Create analysis board"
        onOk={() => void handleCreateBoard()}
        confirmLoading={saving}
        onCancel={() => setBoardModalOpen(false)}
      >
        <Form form={boardForm} layout="vertical">
          <Form.Item name="title" label="Title" rules={[{ required: true, message: "Enter a title." }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={taskModalOpen}
        title="Create task"
        onOk={() => void handleCreateTask()}
        confirmLoading={saving}
        onCancel={() => setTaskModalOpen(false)}
      >
        <TaskForm form={taskForm} board={board} members={members} />
      </Modal>

      <Modal
        open={columnsModalOpen}
        title="Manage columns"
        width={720}
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
                {column.isDone ? <Tag color="green">Done</Tag> : null}
                <Typography.Text type="secondary">{column.tasks.length} tasks</Typography.Text>
              </Space>
              <Space wrap>
                <Button size="small" disabled={index === 0} onClick={() => void moveColumn(column.id, -1)}>
                  Up
                </Button>
                <Button
                  size="small"
                  disabled={index === (board?.columns.length ?? 1) - 1}
                  onClick={() => void moveColumn(column.id, 1)}
                >
                  Down
                </Button>
                <Button size="small" onClick={() => setEditingColumn(column)}>
                  Edit
                </Button>
                <Popconfirm
                  title="Delete this column?"
                  description="Cards will move to the next available column."
                  onConfirm={() => void deleteColumn(column.id)}
                >
                  <Button size="small" danger disabled={(board?.columns.length ?? 0) <= 1}>
                    Delete
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          ))}
          <Form form={columnForm} layout="inline">
            <Form.Item name="title" rules={[{ required: true, message: "Enter a title." }]}>
              <Input placeholder="Column title" maxLength={80} />
            </Form.Item>
            <Form.Item name="color">
              <Input placeholder="Color" maxLength={32} />
            </Form.Item>
            <Form.Item name="isDone" valuePropName="checked">
              <Checkbox>Done</Checkbox>
            </Form.Item>
            <Form.Item>
              <Button type="primary" loading={saving} onClick={() => void handleCreateColumn()}>
                Add column
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Modal>

      <Modal
        open={Boolean(editingColumn)}
        title="Edit column"
        onOk={() => void handleUpdateColumn()}
        confirmLoading={saving}
        onCancel={() => setEditingColumn(null)}
      >
        <Form form={columnEditForm} layout="vertical">
          <Form.Item name="title" label="Title" rules={[{ required: true, message: "Enter a title." }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="color" label="Color">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="isDone" valuePropName="checked">
            <Checkbox>Done</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={Boolean(editingTask)}
        title={editingTask?.title ?? "Task"}
        width={720}
        onClose={() => setEditingTask(null)}
        extra={
          <Space>
            <Popconfirm title="Delete this task?" onConfirm={() => void handleDeleteTask()}>
              <Button danger icon={<DeleteOutlined />} disabled={!canWrite}>
                Delete
              </Button>
            </Popconfirm>
            <Button type="primary" loading={saving} disabled={!canWrite} onClick={() => void handleUpdateTask()}>
              Save
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
              title="Task discussion"
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
  return (
    <Form form={form} layout="vertical" initialValues={{ priority: "normal" }}>
      <Form.Item name="title" label="Title" rules={[{ required: true, message: "Enter a title." }]}>
        <Input maxLength={160} />
      </Form.Item>
      <Form.Item name="bodyMarkdown" label="Details">
        <Input.TextArea rows={4} maxLength={10000} />
      </Form.Item>
      <div className="grid gap-3 md:grid-cols-2">
        <Form.Item name="columnId" label="Column">
          <Select
            options={board?.columns.map((column) => ({
              value: column.id,
              label: column.title,
            }))}
          />
        </Form.Item>
        <Form.Item name="priority" label="Priority">
          <Select options={PRIORITY_OPTIONS.map(({ value, label }) => ({ value, label }))} />
        </Form.Item>
        <Form.Item name="assigneeId" label="Assignee">
          <Select allowClear options={memberOptions(members)} />
        </Form.Item>
        <Form.Item name="dueAt" label="Due date">
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="linkedSubjectType" label="Linked subject">
          <Select allowClear options={SUBJECT_OPTIONS} />
        </Form.Item>
        <Form.Item name="linkedSubjectId" label="Subject ID">
          <Input maxLength={191} prefix={<FolderOpenOutlined />} />
        </Form.Item>
      </div>
    </Form>
  );
}
