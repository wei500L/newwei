"use client";

import { Alert, Button, Form, Input, InputNumber, Modal, Space, Spin, Switch, Table, Typography, message, Tag } from "antd";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import {
  useKnowledgeGraphEvidenceReviewQueueQuery,
  useReviewKnowledgeGraphEvidenceMutation
} from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

type ReviewRow = NonNullable<
  ReturnType<typeof useKnowledgeGraphEvidenceReviewQueueQuery>["data"]
>["knowledgeGraphEvidenceReviewQueue"][number];

function readNestedString(value: unknown, path: string[]) {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

function readNestedNumber(value: unknown, path: string[]) {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : null;
}

function readNestedArray(value: unknown, path: string[]) {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? cursor : null;
}

function isCorrectedRelationDraft(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const subject = record.subject;
  const object = record.object;
  const predicate = typeof record.predicate === "string" ? record.predicate.trim() : "";
  const hasEntityRef = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const entity = candidate as Record<string, unknown>;
    return (
      typeof entity.name === "string" &&
      entity.name.trim().length > 0 &&
      typeof entity.type === "string" &&
      entity.type.trim().length > 0
    );
  };
  return predicate.length > 0 && hasEntityRef(subject) && hasEntityRef(object);
}

export function KnowledgeGraphReviewPanel() {
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  const [maxConfidence, setMaxConfidence] = useState<number | null>(0.6);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsRow, setDetailsRow] = useState<ReviewRow | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<ReviewRow | null>(null);
  const [reviewStatus, setReviewStatus] = useState<"approved" | "rejected" | "corrected">("approved");
  const [reviewNote, setReviewNote] = useState<string>("");
  const [correctedDraft, setCorrectedDraft] = useState<string>("");
  const [quickReviewingId, setQuickReviewingId] = useState<string | null>(null);

  const { data, loading, error, refetch } = useKnowledgeGraphEvidenceReviewQueueQuery({
    variables: {
      limit: 50,
      maxConfidence: typeof maxConfidence === "number" ? maxConfidence : undefined,
      onlyUnreviewed
    },
    fetchPolicy: "network-only"
  });

  const [reviewEvidence, { loading: saving }] = useReviewKnowledgeGraphEvidenceMutation();

  const rows = data?.knowledgeGraphEvidenceReviewQueue ?? [];

  const openDetails = useCallback((row: ReviewRow) => {
    setDetailsRow(row);
    setDetailsOpen(true);
  }, []);

  const openReview = useCallback((row: ReviewRow, status: "approved" | "rejected" | "corrected") => {
    setReviewTarget(row);
    setReviewStatus(status);
    setReviewNote("");
    if (status === "corrected") {
      const skeleton = {
        subject: { name: row.edge.fromEntity.name, type: row.edge.fromEntity.type },
        predicate: row.edge.type,
        object: { name: row.edge.toEntity.name, type: row.edge.toEntity.type }
      };
      setCorrectedDraft(JSON.stringify(skeleton, null, 2));
    } else {
      setCorrectedDraft("");
    }
    setReviewOpen(true);
  }, []);

  const resetReviewDraft = useCallback(() => {
    setReviewOpen(false);
    setReviewTarget(null);
    setReviewStatus("approved");
    setReviewNote("");
    setCorrectedDraft("");
  }, []);

  const applyReview = useCallback(
    async (input: {
      target: ReviewRow;
      status: "approved" | "rejected" | "corrected";
      note?: string | null;
      correctedRelation?: unknown | null;
      closeModal?: boolean;
      quick?: boolean;
    }) => {
      if (input.quick) {
        setQuickReviewingId(input.target.id);
      }

      try {
        await reviewEvidence({
          variables: {
            input: {
              evidenceId: input.target.id,
              status: input.status,
              note: input.note ?? null,
              correctedRelation:
                input.correctedRelation === undefined
                  ? null
                  : input.correctedRelation,
            },
          },
        });
        if (input.closeModal) {
          resetReviewDraft();
        }
        await refetch();
        messageApi.success(t("settings.knowledgeGraphReview.messages.saved"));
      } catch (error) {
        captureClientError("Failed to review knowledge graph evidence", error);
        messageApi.error(t("settings.knowledgeGraphReview.messages.saveFailed"));
      } finally {
        if (input.quick) {
          setQuickReviewingId((current) =>
            current === input.target.id ? null : current,
          );
        }
      }
    },
    [messageApi, refetch, resetReviewDraft, reviewEvidence, t],
  );

  const submitReview = async () => {
    if (!reviewTarget) {
      return;
    }

    let correctedRelation: unknown | null | undefined = undefined;
    if (reviewStatus === "corrected") {
      const trimmed = correctedDraft.trim();
      if (!trimmed) {
        correctedRelation = null;
      } else {
        try {
          correctedRelation = JSON.parse(trimmed) as unknown;
        } catch {
          messageApi.error(t("settings.knowledgeGraphReview.messages.invalidJson"));
          return;
        }
        if (!isCorrectedRelationDraft(correctedRelation)) {
          messageApi.error(t("settings.knowledgeGraphReview.messages.invalidRelation"));
          return;
        }
      }
    }

    await applyReview({
      target: reviewTarget,
      status: reviewStatus,
      note: reviewNote.trim().length > 0 ? reviewNote.trim() : null,
      correctedRelation,
      closeModal: true,
    });
  };

  const detailsEvidence = detailsRow?.evidence ?? null;
  const detailsValidation = detailsRow?.evidence ? readNestedString(detailsRow.evidence, ["validation", "outcome"]) : null;

  const columns = useMemo(
    () => [
      {
        title: t("settings.knowledgeGraphReview.columns.article"),
        dataIndex: "article",
        key: "article",
        render: (_: unknown, row: ReviewRow) => (
          <Space direction="vertical" size={0}>
            <Link href={row.article.url} target="_blank" rel="noreferrer">
              {row.article.title ?? row.article.url}
            </Link>
            <Typography.Text type="secondary">
              {new Date(row.createdAt).toLocaleString()}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: t("settings.knowledgeGraphReview.columns.relation"),
        dataIndex: "edge",
        key: "edge",
        render: (_: unknown, row: ReviewRow) => (
          <Typography.Text>
            {row.edge.fromEntity.name} - {row.edge.type} {"->"} {row.edge.toEntity.name}
          </Typography.Text>
        )
      },
      {
        title: t("settings.knowledgeGraphReview.columns.confidence"),
        key: "confidence",
        render: (_: unknown, row: ReviewRow) => (
          <Space>
            <Typography.Text>{row.confidence?.toFixed(2) ?? "-"}</Typography.Text>
            <Typography.Text type="secondary">
              {t("settings.knowledgeGraphReview.labels.edge")} {row.edge.confidence.toFixed(2)}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: t("settings.knowledgeGraphReview.columns.validation"),
        key: "validation",
        render: (_: unknown, row: ReviewRow) => {
          const evidence = row.evidence as unknown;
          const outcome = readNestedString(evidence, ["validation", "outcome"]);
          const yes = readNestedNumber(evidence, ["validation", "votes", "yes"]);
          const no = readNestedNumber(evidence, ["validation", "votes", "no"]);
          const uncertain = readNestedNumber(evidence, ["validation", "votes", "uncertain"]);
          const reviewedStatus = readNestedString(evidence, ["review", "status"]);
          const adjusted = readNestedNumber(evidence, ["validation", "adjustedConfidence"]);

          let outcomeColor: string | undefined;
          if (outcome === "accept") {
            outcomeColor = "success";
          } else if (outcome === "reject") {
            outcomeColor = "error";
          } else if (outcome) {
            outcomeColor = "warning";
          }

          return (
            <Space wrap>
              {outcome ? <Tag color={outcomeColor}>{outcome}</Tag> : <Tag color="default">-</Tag>}
              {adjusted !== null ? (
                <Typography.Text type="secondary">
                  {t("settings.knowledgeGraphReview.labels.adjusted")} {adjusted.toFixed(2)}
                </Typography.Text>
              ) : null}
              {yes !== null || no !== null || uncertain !== null ? (
                <Typography.Text type="secondary">
                  {t("settings.knowledgeGraphReview.labels.votes", {
                    yes: yes ?? 0,
                    no: no ?? 0,
                    uncertain: uncertain ?? 0
                  })}
                </Typography.Text>
              ) : null}
              {reviewedStatus ? (
                <Tag color={reviewedStatus === "approved" ? "success" : reviewedStatus === "rejected" ? "error" : undefined}>
                  {reviewedStatus}
                </Tag>
              ) : null}
            </Space>
          );
        }
      },
      {
        title: t("settings.knowledgeGraphReview.columns.evidence"),
        key: "evidence",
        render: (_: unknown, row: ReviewRow) => {
          const quote = readNestedString(row.evidence, ["quote"]);
          if (!quote) {
            return <Typography.Text type="secondary">-</Typography.Text>;
          }
          const clipped = quote.length > 120 ? `${quote.slice(0, 120)}...` : quote;
          return <Typography.Text title={quote}>{clipped}</Typography.Text>;
        }
      },
      {
        title: t("settings.knowledgeGraphReview.columns.actions"),
        key: "actions",
        render: (_: unknown, row: ReviewRow) => {
          const reviewedStatus = readNestedString(row.evidence, ["review", "status"]);
          const disabled = saving || loading || Boolean(reviewedStatus) || Boolean(quickReviewingId);

          return (
            <Space>
              <Button
                type="primary"
                size="small"
                disabled={disabled}
                loading={quickReviewingId === row.id}
                onClick={(evt) => {
                  evt.stopPropagation();
                  void applyReview({
                    target: row,
                    status: "approved",
                    closeModal: false,
                    quick: true,
                  });
                }}
              >
                {t("settings.knowledgeGraphReview.actions.approve")}
              </Button>
              <Button
                danger
                size="small"
                disabled={disabled}
                onClick={(evt) => {
                  evt.stopPropagation();
                  openReview(row, "rejected");
                }}
              >
                {t("settings.knowledgeGraphReview.actions.reject")}
              </Button>
              <Button
                size="small"
                disabled={disabled}
                onClick={(evt) => {
                  evt.stopPropagation();
                  openReview(row, "corrected");
                }}
              >
                {t("settings.knowledgeGraphReview.actions.correct")}
              </Button>
            </Space>
          );
        }
      }
    ],
    [applyReview, loading, openReview, quickReviewingId, saving, t]
  );

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" className="!mb-4">
        {t("settings.knowledgeGraphReview.description")}
      </Typography.Paragraph>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.knowledgeGraphReview.messages.loadFailed")}
          description={error.message}
          className="!mb-4"
        />
      ) : null}

      <Space className="!mb-4" wrap>
        <Space>
          <Typography.Text>{t("settings.knowledgeGraphReview.filters.maxConfidence")}</Typography.Text>
          <InputNumber
            min={0}
            max={1}
            step={0.05}
            value={maxConfidence ?? undefined}
            onChange={(value) => setMaxConfidence(typeof value === "number" ? value : null)}
          />
        </Space>
        <Space>
          <Typography.Text>{t("settings.knowledgeGraphReview.filters.onlyUnreviewed")}</Typography.Text>
          <Switch checked={onlyUnreviewed} onChange={setOnlyUnreviewed} />
        </Space>
        <Button onClick={() => refetch()} disabled={loading}>
          {t("settings.knowledgeGraphReview.actions.refresh")}
        </Button>
      </Space>

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-10">
          <Spin />
        </div>
      ) : rows.length === 0 ? (
        <ChartEmptyState presentation="banner" description={t("settings.knowledgeGraphReview.empty")} />
      ) : (
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          pagination={false}
          onRow={(record) => ({
            onClick: () => openDetails(record)
          })}
          scroll={{ x: "max-content" }}
        />
      )}

      <Modal
        open={detailsOpen}
        onCancel={() => setDetailsOpen(false)}
        footer={null}
        title={t("settings.knowledgeGraphReview.details.title")}
        width="min(820px, calc(100vw - 32px))"
      >
        {detailsRow ? (
          <>
            <Typography.Paragraph className="!mb-1">
              <Link href={detailsRow.article.url} target="_blank" rel="noreferrer">
                {detailsRow.article.title ?? detailsRow.article.url}
              </Link>
            </Typography.Paragraph>
            {detailsRow.article.summary ? (
              <Typography.Paragraph type="secondary">
                {detailsRow.article.summary}
              </Typography.Paragraph>
            ) : null}

            <Typography.Paragraph>
              <Typography.Text strong>
                {detailsRow.edge.fromEntity.name} - {detailsRow.edge.type} {"->"} {detailsRow.edge.toEntity.name}
              </Typography.Text>
            </Typography.Paragraph>

            {readNestedString(detailsEvidence, ["quote"]) ? (
              <Typography.Paragraph>
                <Typography.Text type="secondary">
                  {t("settings.knowledgeGraphReview.details.quote")}
                </Typography.Text>
                <div className="mt-1" style={{ whiteSpace: "pre-wrap" }}>
                  {readNestedString(detailsEvidence, ["quote"])}
                </div>
              </Typography.Paragraph>
            ) : null}

            <Typography.Paragraph>
              <Typography.Text type="secondary">
                {t("settings.knowledgeGraphReview.details.validation")}
              </Typography.Text>
              <div className="mt-1">
                <Space wrap>
                  {detailsValidation ? <Tag>{detailsValidation}</Tag> : <Tag color="default">-</Tag>}
                  {readNestedNumber(detailsEvidence, ["validation", "supportScore"]) !== null ? (
                    <Tag>
                      {t("settings.knowledgeGraphReview.details.supportScore", {
                        value: Number(readNestedNumber(detailsEvidence, ["validation", "supportScore"])).toFixed(2)
                      })}
                    </Tag>
                  ) : null}
                  {readNestedNumber(detailsEvidence, ["validation", "originalConfidence"]) !== null ? (
                    <Tag>
                      {t("settings.knowledgeGraphReview.details.originalConfidence", {
                        value: Number(readNestedNumber(detailsEvidence, ["validation", "originalConfidence"])).toFixed(2)
                      })}
                    </Tag>
                  ) : null}
                  {readNestedNumber(detailsEvidence, ["validation", "adjustedConfidence"]) !== null ? (
                    <Tag>
                      {t("settings.knowledgeGraphReview.details.adjustedConfidence", {
                        value: Number(readNestedNumber(detailsEvidence, ["validation", "adjustedConfidence"])).toFixed(2)
                      })}
                    </Tag>
                  ) : null}
                </Space>
              </div>
            </Typography.Paragraph>

            {(() => {
              const results = readNestedArray(detailsEvidence, ["validation", "results"]);
              const rows =
                results?.map((entry, index) => {
                  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                    return null;
                  }
                  const record = entry as Record<string, unknown>;
                  return {
                    key: `${index}`,
                    model: typeof record.model === "string" ? record.model : "-",
                    verdict: typeof record.verdict === "string" ? record.verdict : "-",
                    confidence: typeof record.confidence === "number" ? record.confidence : null,
                    error: typeof record.error === "string" ? record.error : null
                  };
                })?.filter(Boolean) ?? [];

              if (rows.length === 0) {
                return null;
              }

              return (
                <>
                  <Typography.Paragraph type="secondary" className="!mb-2">
                    {t("settings.knowledgeGraphReview.details.modelResults")}
                  </Typography.Paragraph>
                  <Table
                    size="small"
                    pagination={false}
                    dataSource={rows}
                    columns={[
                      { title: t("settings.knowledgeGraphReview.details.columns.model"), dataIndex: "model", key: "model" },
                      { title: t("settings.knowledgeGraphReview.details.columns.verdict"), dataIndex: "verdict", key: "verdict" },
                      {
                        title: t("settings.knowledgeGraphReview.details.columns.confidence"),
                        dataIndex: "confidence",
                        key: "confidence",
                        render: (value: unknown) => (typeof value === "number" ? value.toFixed(2) : "-")
                      },
                      { title: t("settings.knowledgeGraphReview.details.columns.error"), dataIndex: "error", key: "error" }
                    ]}
                    scroll={{ x: "max-content" }}
                  />
                </>
              );
            })()}
          </>
        ) : null}
      </Modal>

      <Modal
        open={reviewOpen}
        onCancel={resetReviewDraft}
        okText={t("common.saveChanges")}
        okButtonProps={{ loading: saving }}
        onOk={submitReview}
        title={t("settings.knowledgeGraphReview.review.title")}
        width="min(720px, calc(100vw - 32px))"
        destroyOnHidden
      >
        {reviewTarget ? (
          <>
            <Typography.Paragraph type="secondary" className="!mb-3">
              {reviewTarget.edge.fromEntity.name} - {reviewTarget.edge.type} {"->"} {reviewTarget.edge.toEntity.name}
            </Typography.Paragraph>

            <Form layout="vertical" name="knowledge-graph-review-form">
              <Form.Item label={t("settings.knowledgeGraphReview.review.fields.note")}>
                <Input.TextArea
                  rows={3}
                  maxLength={500}
                  value={reviewNote}
                  onChange={(evt) => setReviewNote(evt.target.value)}
                  placeholder={t("settings.knowledgeGraphReview.review.placeholders.note")}
                />
              </Form.Item>

              {reviewStatus === "corrected" ? (
                <Form.Item label={t("settings.knowledgeGraphReview.review.fields.correctedRelation")}>
                  <Input.TextArea
                    rows={8}
                    value={correctedDraft}
                    onChange={(evt) => setCorrectedDraft(evt.target.value)}
                    placeholder='{"subject": {"name": "...", "type": "..."}, "predicate": "...", "object": {"name": "...", "type": "..."}}'
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
                  />
                </Form.Item>
              ) : null}
            </Form>
          </>
        ) : null}
      </Modal>
    </>
  );
}
