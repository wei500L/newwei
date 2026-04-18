"use client";

import {
  CopyOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  SaveOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import type { AxiosResponse } from "axios";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import {
  buildSavedViewPath,
  downloadBlob,
  formatAnalysisActorName,
  type SavedAnalysisSurface,
  type SavedAnalysisView,
  type SavedAnalysisVisibility,
  sanitizeAnalysisQueryString,
} from "@/lib/analysis-workspace";

interface SaveViewFormValues {
  title: string;
  description?: string;
  visibility: SavedAnalysisVisibility;
}

interface AnalysisToolbarProps {
  surface: SavedAnalysisSurface;
  exportTarget: "search" | "items" | "events";
  queryString: string;
  savedViewId?: string | null;
}

const EXPORT_FILE_NAMES: Record<AnalysisToolbarProps["exportTarget"], string> = {
  search: "analysis-search-export.csv",
  items: "analysis-items-export.csv",
  events: "analysis-events-export.csv",
};

export function AnalysisToolbar({
  surface,
  exportTarget,
  queryString,
  savedViewId = null,
}: AnalysisToolbarProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<SaveViewFormValues>();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [savedView, setSavedView] = useState<SavedAnalysisView | null>(null);
  const [loadingView, setLoadingView] = useState(false);

  const accessToken = session?.accessToken;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canWrite = permissions.includes("analysis.write");
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );
  const sanitizedQueryString = useMemo(
    () => sanitizeAnalysisQueryString(queryString),
    [queryString],
  );

  useEffect(() => {
    if (!savedViewId || !accessToken) {
      setSavedView(null);
      return;
    }

    let cancelled = false;
    setLoadingView(true);
    void apiClient
      .get<SavedAnalysisView>(`analysis/views/${savedViewId}`)
      .then((response) => {
        if (!cancelled) {
          setSavedView(response.data);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          captureClientError("Failed to load saved analysis view", error);
          setSavedView(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingView(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, apiClient, savedViewId]);

  const openSaveModal = useCallback(() => {
    form.setFieldsValue({
      title: savedView?.title ?? "",
      description: savedView?.description ?? undefined,
      visibility: savedView?.visibility ?? "private",
    });
    setSaveOpen(true);
  }, [form, savedView]);

  const handleSave = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      const createPayload = {
        title: values.title.trim(),
        description: values.description?.trim() || undefined,
        visibility: values.visibility,
        surface,
        routePath: pathname,
        queryString: sanitizedQueryString,
      };

      const response = savedView?.id && savedView.canEdit
        ? await apiClient.patch<SavedAnalysisView>(
            `analysis/views/${savedView.id}`,
            {
              title: createPayload.title,
              description: createPayload.description,
              visibility: createPayload.visibility,
              routePath: createPayload.routePath,
              queryString: createPayload.queryString,
            },
          )
        : await apiClient.post<SavedAnalysisView>("analysis/views", createPayload);

      const nextView = response.data;
      setSavedView(nextView);
      setSaveOpen(false);
      messageApi.success(
        savedView?.id && savedView.canEdit
          ? t("analysis.toolbar.updateSuccess", {
              defaultValue: "Saved view updated.",
            })
          : t("analysis.toolbar.createSuccess", {
              defaultValue: "Saved view created.",
            }),
      );
      router.replace(
        buildSavedViewPath(pathname, sanitizedQueryString, nextView.id),
        { scroll: false },
      );
    } catch (error) {
      const isValidationError =
        typeof error === "object" &&
        error !== null &&
        "errorFields" in error &&
        Array.isArray((error as { errorFields?: unknown }).errorFields);
      if (isValidationError) {
        return;
      }
      captureClientError("Failed to save analysis view", error);
      messageApi.error(
        t("analysis.toolbar.saveFailed", {
          defaultValue: "Failed to save view.",
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [
    apiClient,
    form,
    messageApi,
    pathname,
    router,
    sanitizedQueryString,
    savedView,
    surface,
    t,
  ]);

  const handleExport = useCallback(async () => {
    try {
      setExporting(true);
      const response = await apiClient.post<Blob, AxiosResponse<Blob>>(
        `analysis/exports/${exportTarget}`,
        { queryString: sanitizedQueryString },
        { responseType: "blob" },
      );
      downloadBlob(response.data, EXPORT_FILE_NAMES[exportTarget]);
    } catch (error) {
      captureClientError("Failed to export analysis CSV", error);
      messageApi.error(
        t("analysis.toolbar.exportFailed", {
          defaultValue: "Failed to export CSV.",
        }),
      );
    } finally {
      setExporting(false);
    }
  }, [apiClient, exportTarget, messageApi, sanitizedQueryString, t]);

  const handleCopyLink = useCallback(async () => {
    if (!savedViewId) {
      return;
    }
    try {
      setCopying(true);
      const target = buildSavedViewPath(pathname, sanitizedQueryString, savedViewId);
      await navigator.clipboard.writeText(`${window.location.origin}${target}`);
      messageApi.success(
        t("analysis.toolbar.copySuccess", {
          defaultValue: "Share link copied.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to copy analysis share link", error);
      messageApi.error(
        t("analysis.toolbar.copyFailed", {
          defaultValue: "Failed to copy link.",
        }),
      );
    } finally {
      setCopying(false);
    }
  }, [messageApi, pathname, sanitizedQueryString, savedViewId, t]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-white/70 p-4 shadow-sm">
      {contextHolder}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <Space wrap size={[8, 8]}>
            <Typography.Text strong>
              {t("analysis.toolbar.title", {
                defaultValue: "Analysis workspace",
              })}
            </Typography.Text>
            <Tag color="blue">{surface}</Tag>
            {savedView ? (
              <Tag color={savedView.visibility === "org_shared" ? "gold" : "default"}>
                {savedView.visibility === "org_shared"
                  ? t("analysis.toolbar.shared", {
                      defaultValue: "Org shared",
                    })
                  : t("analysis.toolbar.private", {
                      defaultValue: "Private",
                    })}
              </Tag>
            ) : null}
            {savedView && savedView.canEdit ? (
              <Tag color="processing">
                {t("analysis.toolbar.editable", {
                  defaultValue: "You can edit this view",
                })}
              </Tag>
            ) : null}
          </Space>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {savedView
              ? savedView.description ||
                t("analysis.toolbar.savedDescription", {
                  defaultValue:
                    "This saved analysis view can be reopened, exported, and discussed with your team.",
                })
              : t("analysis.toolbar.unsavedDescription", {
                  defaultValue:
                    "Save the current filters as an internal view, export the result set, or continue into the analysis library.",
                })}
          </Typography.Paragraph>
          {savedView ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("analysis.toolbar.updatedBy", {
                defaultValue: "Last updated by {{name}}",
                name: formatAnalysisActorName(savedView.updatedBy),
              })}
            </Typography.Text>
          ) : null}
          {!canWrite ? (
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message={t("analysis.toolbar.permissionTitle", {
                defaultValue: "Read-only access",
              })}
              description={t("analysis.toolbar.permissionDescription", {
                defaultValue:
                  "Saving views, exporting CSV, and annotations require analysis.write permission.",
              })}
            />
          ) : null}
        </div>

        <Space wrap>
          <Link href="/analysis">
            <Button icon={<FolderOpenOutlined />}>
              {t("analysis.toolbar.library", {
                defaultValue: "Analysis library",
              })}
            </Button>
          </Link>
          {savedViewId ? (
            <Button
              icon={<ShareAltOutlined />}
              onClick={() => void handleCopyLink()}
              loading={copying}
            >
              {t("analysis.toolbar.share", {
                defaultValue: "Copy link",
              })}
            </Button>
          ) : null}
          <Button
            icon={<DownloadOutlined />}
            onClick={() => void handleExport()}
            loading={exporting}
            disabled={!canWrite}
          >
            {t("analysis.toolbar.export", {
              defaultValue: "Export CSV",
            })}
          </Button>
          <Button
            type="primary"
            icon={savedView ? <CopyOutlined /> : <SaveOutlined />}
            onClick={openSaveModal}
            disabled={!canWrite}
            loading={loadingView}
          >
            {savedView?.id && savedView.canEdit
              ? t("analysis.toolbar.update", {
                  defaultValue: "Update view",
                })
              : t("analysis.toolbar.save", {
                  defaultValue: "Save view",
                })}
          </Button>
        </Space>
      </div>

      <Modal
        open={saveOpen}
        title={savedView?.id && savedView.canEdit
          ? t("analysis.toolbar.updateModalTitle", {
              defaultValue: "Update saved analysis view",
            })
          : t("analysis.toolbar.createModalTitle", {
              defaultValue: "Save current analysis view",
            })}
        onOk={() => void handleSave()}
        okText={savedView?.id && savedView.canEdit
          ? t("common.save", { defaultValue: "Save" })
          : t("analysis.toolbar.save", { defaultValue: "Save view" })}
        confirmLoading={saving}
        onCancel={() => setSaveOpen(false)}
      >
        <Form layout="vertical" form={form}>
          <Form.Item
            label={t("analysis.toolbar.fields.title", {
              defaultValue: "Title",
            })}
            name="title"
            rules={[
              {
                required: true,
                message: t("analysis.toolbar.fields.titleRequired", {
                  defaultValue: "Enter a title.",
                }),
              },
            ]}
          >
            <Input
              maxLength={120}
              placeholder={t("analysis.toolbar.fields.titlePlaceholder", {
                defaultValue: "South China Sea watchlist",
              })}
            />
          </Form.Item>
          <Form.Item
            label={t("analysis.toolbar.fields.description", {
              defaultValue: "Description",
            })}
            name="description"
          >
            <Input.TextArea
              rows={3}
              maxLength={1000}
              placeholder={t("analysis.toolbar.fields.descriptionPlaceholder", {
                defaultValue: "What this saved view tracks and why it matters.",
              })}
            />
          </Form.Item>
          <Form.Item
            label={t("analysis.toolbar.fields.visibility", {
              defaultValue: "Visibility",
            })}
            name="visibility"
            initialValue="private"
          >
            <Select
              options={[
                {
                  value: "private",
                  label: t("analysis.toolbar.private", {
                    defaultValue: "Private",
                  }),
                },
                {
                  value: "org_shared",
                  label: t("analysis.toolbar.shared", {
                    defaultValue: "Org shared",
                  }),
                },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
