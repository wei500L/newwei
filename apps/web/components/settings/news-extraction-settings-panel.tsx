"use client";

import {
  Button,
  Card,
  Form,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
  message,
} from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  useNewsExtractionSettingsQuery,
  useUpdateNewsExtractionSettingsMutation,
  type UpdateNewsExtractionSettingsInput,
} from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

export function NewsExtractionSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<UpdateNewsExtractionSettingsInput>();
  const { data, loading, refetch } = useNewsExtractionSettingsQuery();
  const [updateSettings, { loading: saving }] =
    useUpdateNewsExtractionSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    const settings = data?.newsExtractionSettings;
    if (!settings) {
      return;
    }
    form.setFieldsValue({
      pipelineMode: settings.pipelineMode,
      preflightGate: { ...settings.preflightGate },
      postCleanGate: { ...settings.postCleanGate },
      capabilities: { ...settings.capabilities },
      providers: { ...settings.providers },
    });
  }, [data?.newsExtractionSettings, form]);

  const handleSubmit = async (values: UpdateNewsExtractionSettingsInput) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(
        t("settings.newsExtraction.saved", {
          defaultValue: "News extraction settings saved.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to save news extraction settings", error);
      messageApi.error(
        t("settings.newsExtraction.saveFailed", {
          defaultValue: "Failed to save news extraction settings.",
        }),
      );
    }
  };

  if (loading && !data?.newsExtractionSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {t("settings.newsExtraction.description", {
          defaultValue:
            "Configure staged article cleaning, low-cost quality gates, and downstream enrichment stages.",
        })}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Card
          size="small"
          title={t("settings.newsExtraction.pipelineTitle", {
            defaultValue: "Pipeline mode",
          })}
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            name="pipelineMode"
            label={t("settings.newsExtraction.fields.pipelineMode", {
              defaultValue: "Execution mode",
            })}
          >
            <Select
              options={[
                {
                  label: t("settings.newsExtraction.pipelineModeLegacy", {
                    defaultValue: "Legacy single-pass",
                  }),
                  value: "legacy",
                },
                {
                  label: t("settings.newsExtraction.pipelineModeStaged", {
                    defaultValue: "Staged extraction",
                  }),
                  value: "staged",
                },
              ]}
            />
          </Form.Item>
        </Card>

        <Card
          size="small"
          title={t("settings.newsExtraction.preflightTitle", {
            defaultValue: "Preflight gate",
          })}
          style={{ marginBottom: 16 }}
        >
          <Space size={24} wrap style={{ display: "flex", marginBottom: 16 }}>
            <Form.Item
              name={["preflightGate", "enabled"]}
              label={t("settings.newsExtraction.fields.enabled", {
                defaultValue: "Enabled",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["preflightGate", "rejectBotChallenge"]}
              label={t("settings.newsExtraction.fields.rejectBotChallenge", {
                defaultValue: "Reject bot challenge pages",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["preflightGate", "rejectListLike"]}
              label={t("settings.newsExtraction.fields.rejectListLike", {
                defaultValue: "Reject list-like pages",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item
            name={["preflightGate", "minWordCount"]}
            label={t("settings.newsExtraction.fields.minWordCount", {
              defaultValue: "Minimum word count",
            })}
          >
            <InputNumber min={0} max={10000} style={{ width: "100%" }} />
          </Form.Item>
        </Card>

        <Card
          size="small"
          title={t("settings.newsExtraction.postCleanTitle", {
            defaultValue: "Post-clean gate",
          })}
          style={{ marginBottom: 16 }}
        >
          <Space size={24} wrap style={{ display: "flex", marginBottom: 16 }}>
            <Form.Item
              name={["postCleanGate", "enabled"]}
              label={t("settings.newsExtraction.fields.enabled", {
                defaultValue: "Enabled",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["postCleanGate", "requireSummary"]}
              label={t("settings.newsExtraction.fields.requireSummary", {
                defaultValue: "Require summary",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item
            name={["postCleanGate", "minQualityScore"]}
            label={t("settings.newsExtraction.fields.minQualityScore", {
              defaultValue: "Minimum quality score",
            })}
          >
            <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name={["postCleanGate", "minCleanedChars"]}
            label={t("settings.newsExtraction.fields.minCleanedChars", {
              defaultValue: "Minimum cleaned characters",
            })}
          >
            <InputNumber min={0} max={100000} style={{ width: "100%" }} />
          </Form.Item>
        </Card>

        <Card
          size="small"
          title={t("settings.newsExtraction.capabilitiesTitle", {
            defaultValue: "Downstream enrichment",
          })}
          style={{ marginBottom: 16 }}
        >
          <Space size={24} wrap style={{ display: "flex" }}>
            <Form.Item
              name={["capabilities", "entities"]}
              label={t("settings.newsExtraction.fields.entities", {
                defaultValue: "Entities",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["capabilities", "sentiment"]}
              label={t("settings.newsExtraction.fields.sentiment", {
                defaultValue: "Sentiment",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["capabilities", "kg"]}
              label={t("settings.newsExtraction.fields.kg", {
                defaultValue: "Knowledge graph relations",
              })}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
        </Card>

        <Card
          size="small"
          title={t("settings.newsExtraction.providersTitle", {
            defaultValue: "Providers",
          })}
          style={{ marginBottom: 16 }}
        >
          <Typography.Paragraph type="secondary">
            {t("settings.newsExtraction.providersHint", {
              defaultValue:
                "Provider routing is stage-specific. This rollout currently supports the built-in LLM provider.",
            })}
          </Typography.Paragraph>
          <Form.Item
            name={["providers", "clean"]}
            label={t("settings.newsExtraction.fields.cleanProvider", {
              defaultValue: "Clean provider",
            })}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
          <Form.Item
            name={["providers", "entities"]}
            label={t("settings.newsExtraction.fields.entitiesProvider", {
              defaultValue: "Entity provider",
            })}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
          <Form.Item
            name={["providers", "sentiment"]}
            label={t("settings.newsExtraction.fields.sentimentProvider", {
              defaultValue: "Sentiment provider",
            })}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
          <Form.Item
            name={["providers", "kg"]}
            label={t("settings.newsExtraction.fields.kgProvider", {
              defaultValue: "Knowledge graph provider",
            })}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
        </Card>

        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
