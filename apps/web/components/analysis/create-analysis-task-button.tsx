"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Button, Col, Form, Input, Modal, Row, Select, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  formatAnalysisActorName,
  type AnalysisBoardDetail,
  type AnalysisBoardSummary,
  type AnalysisMemberSummary,
  type AnalysisTaskLinkedSubjectType,
  type AnalysisTaskPriority,
} from "@/lib/analysis-workspace";
import { createApiClient } from "@/lib/api-client";
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

export function CreateAnalysisTaskButton({
  subjectType,
  subjectId,
  defaultTitle,
  buttonText,
  size = "middle",
}: CreateAnalysisTaskButtonProps) {
  const { data: session } = useSession();
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const priorityOptions = useMemo(
    () => [
      { value: "low" as AnalysisTaskPriority, label: t("analysis.createTask.priorityLow") },
      { value: "normal" as AnalysisTaskPriority, label: t("analysis.createTask.priorityNormal") },
      { value: "high" as AnalysisTaskPriority, label: t("analysis.createTask.priorityHigh") },
      { value: "urgent" as AnalysisTaskPriority, label: t("analysis.createTask.priorityUrgent") },
    ],
    [t],
  );
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
      messageApi.error(t("analysis.createTask.loadBoardsFailed"));
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiClient, form, messageApi, t]);

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
        messageApi.error(t("analysis.createTask.loadColumnsFailed"));
      }
    },
    [apiClient, form, messageApi, t],
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
      messageApi.success(t("analysis.createTask.createSuccess"));
    } catch (error) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      captureClientError("Failed to create analysis task from subject", error);
      messageApi.error(t("analysis.createTask.createFailed"));
    } finally {
      setSaving(false);
    }
  }, [apiClient, form, messageApi, subjectId, subjectType, t]);

  return (
    <>
      {contextHolder}
      <Button
        icon={<PlusOutlined />}
        size={size}
        disabled={!canWrite}
        onClick={() => setOpen(true)}
      >
        {buttonText ?? t("analysis.createTask.createButton")}
      </Button>
      <Modal
        open={open}
        title={t("analysis.createTask.title")}
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
      >
        <Form form={form} layout="vertical" initialValues={{ priority: "normal" }}>
          <Form.Item name="boardId" label={t("analysis.createTask.board")} rules={[{ required: true }]}>
            <Select
              loading={loading}
              options={boards.map((board) => ({ value: board.id, label: board.title }))}
            />
          </Form.Item>
          <Form.Item name="columnId" label={t("analysis.createTask.column")} rules={[{ required: true }]}>
            <Select
              options={boardDetail?.columns.map((column) => ({
                value: column.id,
                label: column.title,
              }))}
            />
          </Form.Item>
          <Form.Item name="title" label={t("analysis.createTask.taskTitle")} rules={[{ required: true }]}>
            <Input maxLength={160} />
          </Form.Item>
          <Form.Item name="bodyMarkdown" label={t("analysis.createTask.details")}>
            <Input.TextArea rows={3} maxLength={10000} />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={10}>
              <Form.Item name="priority" label={t("analysis.createTask.priority")}>
                <Select options={priorityOptions} />
              </Form.Item>
            </Col>
            <Col xs={24} md={14}>
              <Form.Item name="assigneeId" label={t("analysis.createTask.assignee")}>
                <Select
                  allowClear
                  options={members.map((member) => ({
                    value: member.id,
                    label: formatAnalysisActorName(member),
                  }))}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
