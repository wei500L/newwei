"use client";

import {
  Button,
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

import { SectionHeader } from "@/components/section-header";
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
      messageApi.success(t("settings.newsExtraction.saved"));
    } catch (error) {
      captureClientError("Failed to save news extraction settings", error);
      messageApi.error(t("settings.newsExtraction.saveFailed"));
    }
  };

  if (loading && !data?.newsExtractionSettings) {
    return (
      <div className="flex justify-center py-10">
        <Spin />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Typography.Paragraph type="secondary" className="m-0">
        {t("settings.newsExtraction.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <section className="flex flex-col gap-3">
          <SectionHeader title={t("settings.newsExtraction.pipelineTitle")} rule />
          <Form.Item
            name="pipelineMode"
            label={t("settings.newsExtraction.fields.pipelineMode")}
          >
            <Select
              options={[
                {
                  label: t("settings.newsExtraction.pipelineModeStaged"),
                  value: "staged",
                },
                {
                  label: t("settings.newsExtraction.pipelineModeLegacy"),
                  value: "legacy",
                },
              ]}
            />
          </Form.Item>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title={t("settings.newsExtraction.preflightTitle")} rule />
          <Space size={24} wrap style={{ display: "flex" }}>
            <Form.Item
              name={["preflightGate", "enabled"]}
              label={t("settings.newsExtraction.fields.enabled")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["preflightGate", "rejectBotChallenge"]}
              label={t("settings.newsExtraction.fields.rejectBotChallenge")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["preflightGate", "rejectListLike"]}
              label={t("settings.newsExtraction.fields.rejectListLike")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item
            name={["preflightGate", "minWordCount"]}
            label={t("settings.newsExtraction.fields.minWordCount")}
          >
            <InputNumber min={0} max={10000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name={["preflightGate", "minQualityScore"]}
            label={t("settings.newsExtraction.fields.minPreflightQualityScore")}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title={t("settings.newsExtraction.postCleanTitle")} rule />
          <Space size={24} wrap style={{ display: "flex" }}>
            <Form.Item
              name={["postCleanGate", "enabled"]}
              label={t("settings.newsExtraction.fields.enabled")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["postCleanGate", "requireSummary"]}
              label={t("settings.newsExtraction.fields.requireSummary")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item
            name={["postCleanGate", "minQualityScore"]}
            label={t("settings.newsExtraction.fields.minCleanedQualityScore")}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name={["postCleanGate", "minCleanedChars"]}
            label={t("settings.newsExtraction.fields.minCleanedChars")}
          >
            <InputNumber min={0} max={100000} style={{ width: "100%" }} />
          </Form.Item>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title={t("settings.newsExtraction.capabilitiesTitle")} rule />
          <Space size={24} wrap style={{ display: "flex" }}>
            <Form.Item
              name={["capabilities", "entities"]}
              label={t("settings.newsExtraction.fields.entities")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["capabilities", "sentiment"]}
              label={t("settings.newsExtraction.fields.sentiment")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name={["capabilities", "kg"]}
              label={t("settings.newsExtraction.fields.kg")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title={t("settings.newsExtraction.providersTitle")} rule />
          <Typography.Paragraph type="secondary">
            {t("settings.newsExtraction.providersHint")}
          </Typography.Paragraph>
          <Form.Item
            name={["providers", "clean"]}
            label={t("settings.newsExtraction.fields.cleanProvider")}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
          <Form.Item
            name={["providers", "entities"]}
            label={t("settings.newsExtraction.fields.entitiesProvider")}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
          <Form.Item
            name={["providers", "sentiment"]}
            label={t("settings.newsExtraction.fields.sentimentProvider")}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
          <Form.Item
            name={["providers", "kg"]}
            label={t("settings.newsExtraction.fields.kgProvider")}
          >
            <Select options={[{ label: "LLM", value: "llm" }]} />
          </Form.Item>
        </section>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
