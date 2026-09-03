"use client";

import {
  DeleteOutlined,
  EditOutlined,
  MessageOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Popconfirm,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CreateAnalysisTaskButton } from "@/components/analysis/create-analysis-task-button";
import { MarkdownViewer } from "@/components/markdown-viewer";
import {
  formatAnalysisActorName,
  type AnalysisSubjectType,
  type AnalysisTaskLinkedSubjectType,
  type AnalysisThread,
} from "@/lib/analysis-workspace";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

interface AnnotationPanelProps {
  subjectType: AnalysisSubjectType;
  subjectId: string;
  title?: string;
}

export function AnnotationPanel({
  subjectType,
  subjectId,
  title,
}: AnnotationPanelProps) {
  const { t, i18n } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [thread, setThread] = useState<AnalysisThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingComment, setSavingComment] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState("");
  const [newComment, setNewComment] = useState("");
  const accessToken = session?.accessToken;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canWrite = permissions.includes("analysis.write");
  const canManageUsers = permissions.includes("users.write");
  const canCreateTaskForSubject = canWrite && subjectType !== "analysis_task";
  const currentUserId = session?.user?.id ?? null;
  const locale = resolveLocale(i18n.language);
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const loadThread = useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiClient.get<AnalysisThread | null>(
        `analysis/threads/${subjectType}/${subjectId}`,
      );
      setThread(response.data);
      setNoteDraft(response.data?.noteMarkdown ?? "");
    } catch (error) {
      captureClientError("Failed to load analysis thread", error);
      messageApi.error(
        t("analysis.annotations.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, subjectId, subjectType, t]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    void loadThread();
  }, [accessToken, loadThread]);

  const handleSaveNote = useCallback(async () => {
    try {
      setSavingNote(true);
      const response = await apiClient.put<AnalysisThread | null>(
        `analysis/threads/${subjectType}/${subjectId}`,
        {
          noteMarkdown: noteDraft.trim() || undefined,
        },
      );
      setThread(response.data);
      setNoteDraft(response.data?.noteMarkdown ?? "");
      messageApi.success(
        t("analysis.annotations.noteSaved"),
      );
    } catch (error) {
      captureClientError("Failed to save analysis note", error);
      messageApi.error(
        t("analysis.annotations.noteSaveFailed"),
      );
    } finally {
      setSavingNote(false);
    }
  }, [apiClient, messageApi, noteDraft, subjectId, subjectType, t]);

  const handleCreateComment = useCallback(async () => {
    const bodyMarkdown = newComment.trim();
    if (!bodyMarkdown) {
      return;
    }
    try {
      setSavingComment(true);
      await apiClient.post(`analysis/threads/${subjectType}/${subjectId}/comments`, {
        bodyMarkdown,
      });
      setNewComment("");
      await loadThread();
      messageApi.success(
        t("analysis.annotations.commentSaved"),
      );
    } catch (error) {
      captureClientError("Failed to create analysis comment", error);
      messageApi.error(
        t("analysis.annotations.commentSaveFailed"),
      );
    } finally {
      setSavingComment(false);
    }
  }, [apiClient, loadThread, messageApi, newComment, subjectId, subjectType, t]);

  const handleUpdateComment = useCallback(
    async (commentId: string) => {
      const bodyMarkdown = commentDrafts[commentId]?.trim();
      if (!bodyMarkdown) {
        return;
      }
      try {
        await apiClient.patch(`analysis/comments/${commentId}`, {
          bodyMarkdown,
        });
        setEditingCommentId(null);
        await loadThread();
        messageApi.success(
          t("analysis.annotations.commentUpdated"),
        );
      } catch (error) {
        captureClientError("Failed to update analysis comment", error);
        messageApi.error(
          t("analysis.annotations.commentUpdateFailed"),
        );
      }
    },
    [apiClient, commentDrafts, loadThread, messageApi, t],
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      try {
        await apiClient.delete(`analysis/comments/${commentId}`);
        await loadThread();
        messageApi.success(
          t("analysis.annotations.commentDeleted"),
        );
      } catch (error) {
        captureClientError("Failed to delete analysis comment", error);
        messageApi.error(
          t("analysis.annotations.commentDeleteFailed"),
        );
      }
    },
    [apiClient, loadThread, messageApi, t],
  );

  return (
    <Card
      className="content-card"
      title={title ?? t("analysis.annotations.title")}
      loading={loading}
    >
      {contextHolder}
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {!canWrite ? (
          <Alert
            type="info"
            showIcon
            message={t("analysis.annotations.readOnlyTitle")}
            description={t("analysis.annotations.readOnlyDescription")}
          />
        ) : null}

        {canCreateTaskForSubject ? (
          <CreateAnalysisTaskButton
            subjectType={subjectType as AnalysisTaskLinkedSubjectType}
            subjectId={subjectId}
            defaultTitle={title}
            buttonText={t("analysis.annotations.createTask")}
          />
        ) : null}

        <div>
          <Typography.Text strong>
            {t("analysis.annotations.noteTitle")}
          </Typography.Text>
          {canWrite ? (
            <Space direction="vertical" size="small" style={{ width: "100%", marginTop: 12 }}>
              <Input.TextArea
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                rows={6}
                maxLength={20000}
                placeholder={t("analysis.annotations.notePlaceholder")}
              />
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={() => void handleSaveNote()}
                  loading={savingNote}
                >
                  {t("analysis.annotations.saveNote")}
                </Button>
                {thread?.updatedAt ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("analysis.annotations.updatedAt", {
                      time: formatDateTime(thread.updatedAt, locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            </Space>
          ) : thread?.noteMarkdown ? (
            <div style={{ marginTop: 12 }}>
              <MarkdownViewer markdown={thread.noteMarkdown} />
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("analysis.annotations.noteEmpty")}
            />
          )}
        </div>

        <div>
          <Space align="center">
            <Typography.Text strong>
              {t("analysis.annotations.commentsTitle")}
            </Typography.Text>
            <Tag>{thread?.comments.length ?? 0}</Tag>
          </Space>
          <div style={{ marginTop: 12 }}>
            {thread?.comments.length ? (
              <List
                itemLayout="vertical"
                dataSource={thread.comments}
                renderItem={(comment) => {
                  const canEditComment =
                    canWrite &&
                    (comment.createdById === currentUserId || canManageUsers);
                  const isEditing = editingCommentId === comment.id;
                  const draft = commentDrafts[comment.id] ?? comment.bodyMarkdown;

                  return (
                    <List.Item
                      key={comment.id}
                      actions={
                        canEditComment
                          ? [
                              isEditing ? (
                                <Button
                                  key="save"
                                  type="link"
                                  icon={<SaveOutlined />}
                                  onClick={() => void handleUpdateComment(comment.id)}
                                >
                                  {t("common.save")}
                                </Button>
                              ) : (
                                <Button
                                  key="edit"
                                  type="link"
                                  icon={<EditOutlined />}
                                  onClick={() => {
                                    setCommentDrafts((current) => ({
                                      ...current,
                                      [comment.id]: comment.bodyMarkdown,
                                    }));
                                    setEditingCommentId(comment.id);
                                  }}
                                >
                                  {t("common.edit")}
                                </Button>
                              ),
                              <Popconfirm
                                key="delete"
                                title={t("analysis.annotations.deleteTitle")}
                                onConfirm={() => void handleDeleteComment(comment.id)}
                              >
                                <Button type="link" danger icon={<DeleteOutlined />}>
                                  {t("common.delete")}
                                </Button>
                              </Popconfirm>,
                            ]
                          : undefined
                      }
                    >
                      <List.Item.Meta
                        avatar={<MessageOutlined />}
                        title={formatAnalysisActorName(comment.createdBy)}
                        description={formatDateTime(comment.updatedAt, locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      />
                      {isEditing ? (
                        <Space direction="vertical" style={{ width: "100%" }}>
                          <Input.TextArea
                            rows={4}
                            maxLength={5000}
                            value={draft}
                            onChange={(event) =>
                              setCommentDrafts((current) => ({
                                ...current,
                                [comment.id]: event.target.value,
                              }))
                            }
                          />
                          <Button
                            onClick={() => setEditingCommentId(null)}
                          >
                            {t("common.cancel")}
                          </Button>
                        </Space>
                      ) : (
                        <MarkdownViewer markdown={comment.bodyMarkdown} />
                      )}
                    </List.Item>
                  );
                }}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("analysis.annotations.commentsEmpty")}
              />
            )}
          </div>
          {canWrite ? (
            <Form layout="vertical" style={{ marginTop: 16 }}>
              <Form.Item
                label={t("analysis.annotations.newComment")}
              >
                <Input.TextArea
                  rows={4}
                  maxLength={5000}
                  value={newComment}
                  onChange={(event) => setNewComment(event.target.value)}
                  placeholder={t("analysis.annotations.commentPlaceholder")}
                />
              </Form.Item>
              <Button
                type="primary"
                onClick={() => void handleCreateComment()}
                loading={savingComment}
              >
                {t("analysis.annotations.addComment")}
              </Button>
            </Form>
          ) : null}
        </div>
      </Space>
    </Card>
  );
}
