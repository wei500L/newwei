"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, Space, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";
import {
  formatAnalysisActorName,
  type AnalysisBoardDetail,
  type AnalysisBoardSummary,
  type AnalysisMemberSummary,
  type AnalysisTaskLinkedSubjectType,
  type AnalysisTaskPriority,
} from "@/lib/analysis-workspace";
import { captureClientError } from "@/lib/client-telemetry";

interface CreateAnalysisTaskButtonProps {
  subjectType: AnalysisTaskLinkedSubjectType;
  subjectId: string;
  defaultTitle?: string;
  buttonText?: string;
  size?: "small" | "middle" | "large";
}

interface RbacMemberRow {
  isActive?: boolean;
  user: AnalysisMemberSummary & { isActive?: boolean };
}

interface TaskFormValues {
  boardId: string;
  columnId: string;
  title: string;
  bodyMarkdown?: string;
  priority: AnalysisTaskPriority;
  assigneeId?: string | null;
}

const PRIORITY_OPTIONS: Array<{ value: AnalysisTaskPriority; label: string }> = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export function CreateAnalysisTaskButton({
  subjectType,
  subjectId,
  defaultTitle,
  buttonText = "Create task",
  size = "middle",
}: CreateAnalysisTaskButtonProps) {
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<TaskFormValues>();
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<AnalysisBoardSummary[]>([]);
  const [boardDetail, setBoardDetail] = useState<AnalysisBoardDetail | null>(null);
  const [members, setMembers] = useState<AnalysisMemberSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const accessToken = session?.accessToken;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canWrite = permissions.includes("analysis.write");
  const canReadUsers = permissions.includes("users.read");
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const loadBoards = useCallback(async () => {
    if (!accessToken) {
      return;
    }
    try {
      setLoading(true);
      const response = await apiClient.get<AnalysisBoardSummary[]>("analysis/boards");
      setBoards(response.data);
      const firstBoardId = response.data[0]?.id;
      if (firstBoardId) {
        form.setFieldValue("boardId", firstBoardId);
      }
    } catch (error) {
      captureClientError("Failed to load analysis boards for task creation", error);
      messageApi.error("Failed to load analysis boards.");
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiClient, form, messageApi]);

  const loadBoard = useCallback(
    async (boardId?: string) => {
      if (!boardId) {
        setBoardDetail(null);
        return;
      }
      try {
        const response = await apiClient.get<AnalysisBoardDetail>(
          `analysis/boards/${boardId}`,
        );
        setBoardDetail(response.data);
        form.setFieldValue("columnId", response.data.columns[0]?.id);
      } catch (error) {
        captureClientError("Failed to load analysis board columns", error);
        messageApi.error("Failed to load board columns.");
      }
    },
    [apiClient, form, messageApi],
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
      captureClientError("Failed to load analysis task assignees", error);
    }
  }, [accessToken, apiClient, canReadUsers]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadBoards();
    void loadMembers();
    form.setFieldsValue({
      title: defaultTitle ?? "",
      priority: "normal",
      assigneeId: null,
    });
  }, [defaultTitle, form, loadBoards, loadMembers, open]);

  const selectedBoardId = Form.useWatch("boardId", form);
  useEffect(() => {
    if (open) {
      void loadBoard(selectedBoardId);
    }
  }, [loadBoard, open, selectedBoardId]);

  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await apiClient.post(`analysis/boards/${values.boardId}/tasks`, {
        title: values.title.trim(),
        bodyMarkdown: values.bodyMarkdown?.trim() || undefined,
        priority: values.priority,
        columnId: values.columnId,
        assigneeId: values.assigneeId || null,
        linkedSubjectType: subjectType,
        linkedSubjectId: subjectId,
      });
      setOpen(false);
      form.resetFields();
      messageApi.success("Task created.");
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis task from subject", error);
      messageApi.error("Failed to create task.");
    } finally {
      setSaving(false);
    }
  }, [apiClient, form, messageApi, subjectId, subjectType]);

  return (
    <>
      {contextHolder}
      <Button
        icon={<PlusOutlined />}
        size={size}
        disabled={!canWrite}
        onClick={() => setOpen(true)}
      >
        {buttonText}
      </Button>
      <Modal
        open={open}
        title="Create analysis task"
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
      >
        <Form form={form} layout="vertical" initialValues={{ priority: "normal" }}>
          <Form.Item name="boardId" label="Board" rules={[{ required: true }]}>
            <Select
              loading={loading}
              options={boards.map((board) => ({ value: board.id, label: board.title }))}
            />
          </Form.Item>
          <Form.Item name="columnId" label="Column" rules={[{ required: true }]}>
            <Select
              options={boardDetail?.columns.map((column) => ({
                value: column.id,
                label: column.title,
              }))}
            />
          </Form.Item>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input maxLength={160} />
          </Form.Item>
          <Form.Item name="bodyMarkdown" label="Details">
            <Input.TextArea rows={3} maxLength={10000} />
          </Form.Item>
          <Space style={{ width: "100%" }} align="start">
            <Form.Item name="priority" label="Priority" style={{ minWidth: 160 }}>
              <Select options={PRIORITY_OPTIONS} />
            </Form.Item>
            <Form.Item name="assigneeId" label="Assignee" style={{ minWidth: 240 }}>
              <Select
                allowClear
                options={members.map((member) => ({
                  value: member.id,
                  label: formatAnalysisActorName(member),
                }))}
              />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}
