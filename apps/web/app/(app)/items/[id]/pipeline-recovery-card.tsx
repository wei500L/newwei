"use client";

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  List,
  Modal,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

type PipelineRunStageStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

interface PipelineRunStageSummary {
  stage: string;
  status: PipelineRunStageStatus;
  at: string;
  error?: { name?: string; message?: string } | null;
}

interface PipelineRunSummary {
  jobId: string;
  rawItemId: string;
  processedItemId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stages: PipelineRunStageSummary[];
}

interface PipelineRunsResponse {
  itemMetaId: string;
  itemStatus: string;
  mongoRef: string;
  runs: PipelineRunSummary[];
}

interface PipelineActionResponse {
  itemMetaId: string;
  rawItemId?: string;
  processedItemId?: string;
  queueJobId?: string;
}

interface PipelineRecoveryCardProps {
  itemMetaId: string;
  currentRawItemId?: string | null;
  onActionComplete?: () => Promise<unknown> | unknown;
}

function getStatusColor(status: string) {
  if (status === "completed") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  if (status === "processing") {
    return "blue";
  }
  return "default";
}

export function PipelineRecoveryCard({
  itemMetaId,
  currentRawItemId,
  onActionComplete,
}: PipelineRecoveryCardProps) {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageSettings = permissions.includes("settings.manage");
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<PipelineRunsResponse | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadRuns = useCallback(async () => {
    if (!canManageSettings || !itemMetaId) {
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<PipelineRunsResponse>(
        "admin/quality/pipeline/runs",
        {
          params: { itemMetaId, limit: 8 },
        },
      );
      setData(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to load pipeline recovery runs", error);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("items.detail.pipelineRecovery.errors.loadFailed", {
              defaultValue: "Failed to load pipeline recovery runs.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, canManageSettings, itemMetaId, t]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const runAction = async (
    action: "replay" | "rollback",
    rawItemId?: string | null,
  ) => {
    const normalizedRaw = rawItemId?.trim() ? rawItemId.trim() : undefined;
    setActionKey(`${action}:${normalizedRaw ?? "current"}`);
    try {
      const response = await apiClient.post<PipelineActionResponse>(
        `admin/quality/pipeline/${action}`,
        {
          itemMetaId,
          ...(normalizedRaw ? { rawItemId: normalizedRaw } : {}),
        },
      );
      messageApi.success(
        action === "replay"
          ? t("items.detail.pipelineRecovery.messages.replaySuccess", {
              defaultValue: "Pipeline replay queued.",
            })
          : t("items.detail.pipelineRecovery.messages.rollbackSuccess", {
              defaultValue: "Pipeline rollback created.",
            }),
      );
      await loadRuns();
      await onActionComplete?.();
      return response.data;
    } catch (error) {
      captureClientError(`Failed to ${action} pipeline`, error);
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("items.detail.pipelineRecovery.errors.actionFailed", {
              defaultValue: "Pipeline recovery action failed.",
            }),
      );
      return null;
    } finally {
      setActionKey(null);
    }
  };

  const confirmAction = (action: "replay" | "rollback", rawItemId?: string | null) => {
    Modal.confirm({
      title:
        action === "replay"
          ? t("items.detail.pipelineRecovery.confirm.replayTitle", {
              defaultValue: "Replay this pipeline run?",
            })
          : t("items.detail.pipelineRecovery.confirm.rollbackTitle", {
              defaultValue: "Rollback to this raw item?",
            }),
      content:
        action === "replay"
          ? t("items.detail.pipelineRecovery.confirm.replayBody", {
              defaultValue:
                "This clones the selected raw item and requeues the pipeline.",
            })
          : t("items.detail.pipelineRecovery.confirm.rollbackBody", {
              defaultValue:
                "This resets the pipeline state so the selected raw item becomes pending again.",
            }),
      okText:
        action === "replay"
          ? t("items.detail.pipelineRecovery.actions.replay", {
              defaultValue: "Replay",
            })
          : t("items.detail.pipelineRecovery.actions.rollback", {
              defaultValue: "Rollback",
            }),
      onOk: async () => {
        await runAction(action, rawItemId);
      },
    });
  };

  if (!canManageSettings || !itemMetaId) {
    return null;
  }

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("items.detail.pipelineRecovery.title", {
          defaultValue: "Pipeline Recovery",
        })}
        extra={
          <Space wrap>
            <Button onClick={() => void loadRuns()} loading={loading}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Button
              type="primary"
              onClick={() => confirmAction("replay", currentRawItemId)}
              loading={actionKey === "replay:current"}
              disabled={!currentRawItemId}
            >
              {t("items.detail.pipelineRecovery.actions.replayCurrent", {
                defaultValue: "Replay current raw item",
              })}
            </Button>
            <Button
              danger
              onClick={() => confirmAction("rollback", currentRawItemId)}
              loading={actionKey === "rollback:current"}
              disabled={!currentRawItemId}
            >
              {t("items.detail.pipelineRecovery.actions.rollbackCurrent", {
                defaultValue: "Rollback current raw item",
              })}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("items.detail.pipelineRecovery.description", {
              defaultValue:
                "Inspect recent processed runs for this item and trigger replay or rollback without leaving the item detail page.",
            })}
          </Typography.Text>

          {errorMessage ? (
            <Alert type="error" showIcon message={errorMessage} />
          ) : null}

          {data ? (
            <Descriptions column={{ xs: 1, lg: 2 }} bordered size="small">
              <Descriptions.Item
                label={t("items.detail.pipelineRecovery.labels.itemStatus", {
                  defaultValue: "Item status",
                })}
              >
                <Tag color={getStatusColor(data.itemStatus)}>{data.itemStatus}</Tag>
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.pipelineRecovery.labels.mongoRef", {
                  defaultValue: "Current raw ref",
                })}
              >
                {data.mongoRef}
              </Descriptions.Item>
            </Descriptions>
          ) : null}

          <List
            loading={loading}
            dataSource={data?.runs ?? []}
            locale={{
              emptyText: (
                <Empty
                  description={t("items.detail.pipelineRecovery.empty", {
                    defaultValue: "No recent pipeline runs found for this item.",
                  })}
                />
              ),
            }}
            renderItem={(run) => (
              <List.Item key={run.jobId || run.processedItemId}>
                <Card className="w-full" size="small">
                  <Space
                    direction="vertical"
                    size="middle"
                    style={{ width: "100%" }}
                  >
                    <Space
                      align="start"
                      style={{
                        width: "100%",
                        justifyContent: "space-between",
                      }}
                      wrap
                    >
                      <Space direction="vertical" size={4}>
                        <Space wrap>
                          <Tag color={getStatusColor(run.status)}>
                            {run.status}
                          </Tag>
                          <Tag>{run.jobId || run.processedItemId}</Tag>
                        </Space>
                        <Typography.Text strong>{run.rawItemId}</Typography.Text>
                        <Typography.Text type="secondary">
                          {t("items.detail.pipelineRecovery.labels.updatedAt", {
                            defaultValue: "Updated",
                          })}
                          : {run.updatedAt}
                        </Typography.Text>
                      </Space>
                      <Space wrap>
                        <Button
                          onClick={() => confirmAction("replay", run.rawItemId)}
                          loading={actionKey === `replay:${run.rawItemId}`}
                        >
                          {t("items.detail.pipelineRecovery.actions.replay", {
                            defaultValue: "Replay",
                          })}
                        </Button>
                        <Button
                          danger
                          onClick={() =>
                            confirmAction("rollback", run.rawItemId)
                          }
                          loading={actionKey === `rollback:${run.rawItemId}`}
                        >
                          {t("items.detail.pipelineRecovery.actions.rollback", {
                            defaultValue: "Rollback",
                          })}
                        </Button>
                      </Space>
                    </Space>

                    <Space wrap>
                      {run.stages.map((stage) => (
                        <Tag key={`${run.processedItemId}-${stage.stage}`} color={getStatusColor(stage.status)}>
                          {stage.stage}: {stage.status}
                        </Tag>
                      ))}
                    </Space>

                    {run.stages.some((stage) => stage.error?.message) ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={t("items.detail.pipelineRecovery.labels.stageErrors", {
                          defaultValue: "Recent stage errors",
                        })}
                        description={run.stages
                          .filter((stage) => stage.error?.message)
                          .map(
                            (stage) =>
                              `${stage.stage}: ${stage.error?.message ?? stage.error?.name ?? ""}`,
                          )
                          .join(" · ")}
                      />
                    ) : null}
                  </Space>
                </Card>
              </List.Item>
            )}
          />
        </Space>
      </Card>
    </>
  );
}
