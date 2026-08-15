"use client";

import { QuestionCircleOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
} from "antd";
import type { ReactElement } from "react";

import type { LlmGatewayProxyGovernanceController } from "./llm-gateway-proxy-governance-panel";
import {
  DEFAULT_LLM_GATEWAY_API_BASE,
  DRAFT_CREATE_KEY,
  DRAFT_EDIT_KEY,
  MAX_LLM_GATEWAY_OUTPUT_TOKENS,
} from "./llm-gateway.types";
import type { LlmGatewaySettingsController } from "./use-llm-gateway-settings";

export function LlmGatewayProfileModals({
  s,
  g,
}: {
  s: LlmGatewaySettingsController;
  g: LlmGatewayProxyGovernanceController;
}): ReactElement {
  const {
    t,
    screens,
    helpIconStyle,
    createOpen,
    setCreateOpen,
    testing,
    testUnsavedConfig,
    listModelsUnsavedConfig,
    loadingModels,
    createForm,
    handleCreate,
    saving,
    apiBaseRules,
    createAssistantWebSearchDisabled,
    editing,
    setEditing,
    editForm,
    handleUpdate,
    editClearApiKey,
    editAssistantWebSearchDisabled,
    testProfile,
    closeTest,
    testForm,
    runTest,
    includeCompletion,
    includeEmbeddings,
    includeRerank,
    testErrorMessage,
    testResult,
    renderTestResult,
    handleListModels,
  } = s;
  const { proxyGovernanceSettings, governanceManagedRuntimeKeyReadable } = g;
  const testProfileCanUseManagedRuntimeKey =
    governanceManagedRuntimeKeyReadable &&
    proxyGovernanceSettings?.enabled === true &&
    proxyGovernanceSettings?.targetProfileId === testProfile?.id;

  return (
    <>
    <Modal
      title={t("settings.llmGateway.modal.createTitle")}
      open={createOpen}
      onCancel={() => {
        setCreateOpen(false);
      }}
      width={screens.md ? 720 : "100%"}
      destroyOnHidden
      footer={[
        <Button
          key="test"
          onClick={() => void testUnsavedConfig("create")}
          loading={testing === DRAFT_CREATE_KEY}
        >
          {t("settings.llmGateway.actions.testUnsaved")}
        </Button>,
        <Button
          key="models"
          onClick={() => void listModelsUnsavedConfig("create")}
          loading={loadingModels === DRAFT_CREATE_KEY}
        >
          {t("settings.llmGateway.actions.models")}
        </Button>,
        <Button
          key="cancel"
          onClick={() => {
            setCreateOpen(false);
          }}
        >
          {t("common.cancel")}
        </Button>,
        <Button
          key="submit"
          type="primary"
          onClick={() => createForm.submit()}
          loading={saving}
        >
          {t("common.submit")}
        </Button>,
      ]}
    >
      <Form
        name="llm-gateway-create"
        form={createForm}
        layout="vertical"
        onFinish={handleCreate}
      >
        <Form.Item
          label={t("settings.llmGateway.fields.name")}
          name="name"
          rules={[
            {
              required: true,
              message: t("settings.llmGateway.validation.nameRequired"),
            },
          ]}
        >
          <Input placeholder={t("settings.llmGateway.placeholders.name")} />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.apiBase")}
          name="apiBase"
          extra={t("settings.llmGateway.hints.apiBase")}
          rules={apiBaseRules}
        >
          <Input placeholder={DEFAULT_LLM_GATEWAY_API_BASE} />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.apiKey")}
          name="apiKey"
          extra={t("settings.llmGateway.hints.apiKey")}
        >
          <Input.Password
            placeholder={t("settings.llmGateway.placeholders.apiKey")}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.model")}
          name="model"
          extra={t("settings.llmGateway.hints.modelOptional")}
        >
          <Input allowClear placeholder="openai/gpt-4o-mini" />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.assistantModel")}
          name="assistantModel"
          extra={t("settings.llmGateway.hints.assistantModel")}
        >
          <Input allowClear placeholder="openai/gpt-4.1-mini" />
        </Form.Item>
        <Form.Item
          name="assistantWebSearchEnabled"
          valuePropName="checked"
          label={t("settings.llmGateway.fields.assistantWebSearchEnabled")}
          extra={
            createAssistantWebSearchDisabled
              ? t(
                  "settings.llmGateway.hints.assistantWebSearchRequiresResponses",
                )
              : t("settings.llmGateway.hints.assistantWebSearchEnabled")
          }
        >
          <Switch disabled={createAssistantWebSearchDisabled} />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.embeddingModel")}
          name="embeddingModel"
        >
          <Input placeholder="openai/text-embedding-3-small" />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.rerankModel")}
          name="rerankModel"
          extra={t("settings.llmGateway.hints.rerankModel")}
        >
          <Input allowClear placeholder="cohere/rerank-v3.5" />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.rerankFallbackModels")}
          name="rerankFallbackModels"
          extra={t("settings.llmGateway.hints.rerankFallbackModels")}
        >
          <Input
            placeholder={t(
              "settings.llmGateway.placeholders.rerankFallbackModels",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.apiSurface")}
          name="apiSurface"
          extra={t("settings.llmGateway.hints.apiSurface")}
        >
          <Select
            options={[
              { label: "chat_completions", value: "chat_completions" },
              { label: "responses", value: "responses" },
            ]}
          />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("settings.llmGateway.fields.timeoutMs")}
            name="timeoutMs"
            rules={[
              {
                required: true,
                message: t("settings.llmGateway.validation.timeoutRequired"),
              },
            ]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={1_000}
              max={900_000}
              step={1_000}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.maxRetries")}
            name="maxRetries"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.validation.maxRetriesRequired",
                ),
              },
            ]}
            style={{ minWidth: 160, flex: 1 }}
          >
            <InputNumber
              min={1}
              max={20}
              step={1}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Space>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("settings.llmGateway.fields.temperature")}
            name="temperature"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.validation.temperatureRequired",
                ),
              },
            ]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={0}
              max={2}
              step={0.1}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.topP")}
            name="topP"
            rules={[
              {
                required: true,
                message: t("settings.llmGateway.validation.topPRequired"),
              },
            ]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.maxOutputTokens")}
            name="maxOutputTokens"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.validation.maxOutputTokensRequired",
                ),
              },
            ]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber
              min={1}
              max={MAX_LLM_GATEWAY_OUTPUT_TOKENS}
              step={50}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.llmGateway.fields.fallbackModels")}
          name="fallbackModels"
          extra={t("settings.llmGateway.hints.fallbackModels")}
        >
          <Input
            placeholder={t("settings.llmGateway.placeholders.fallbackModels")}
          />
        </Form.Item>

        <Form.Item
          label={
            <span>
              {t("settings.llmGateway.fields.responseFormatMode")}
              <Tooltip
                title={t("settings.llmGateway.tooltips.responseFormatMode")}
              >
                <QuestionCircleOutlined style={helpIconStyle} />
              </Tooltip>
            </span>
          }
          name="responseFormatMode"
          extra={t("settings.llmGateway.hints.responseFormatMode")}
        >
          <Select
            options={[
              { label: "json_schema", value: "json_schema" },
              { label: "json_object", value: "json_object" },
              { label: "none", value: "none" },
            ]}
          />
        </Form.Item>

        <Form.Item
          name="sendMetadata"
          valuePropName="checked"
          label={
            <span>
              {t("settings.llmGateway.fields.sendMetadata")}
              <Tooltip
                title={t("settings.llmGateway.tooltips.sendMetadata")}
              >
                <QuestionCircleOutlined style={helpIconStyle} />
              </Tooltip>
            </span>
          }
          extra={t("settings.llmGateway.hints.sendMetadata")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="enabled"
          valuePropName="checked"
          label={t("settings.llmGateway.fields.enabled")}
        >
          <Switch />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={t("settings.llmGateway.modal.editTitle")}
      open={Boolean(editing)}
      onCancel={() => {
        setEditing(null);
      }}
      width={screens.md ? 720 : "100%"}
      destroyOnHidden
      footer={[
        <Button
          key="test"
          onClick={() => void testUnsavedConfig("edit")}
          disabled={!editing}
          loading={testing === DRAFT_EDIT_KEY}
        >
          {t("settings.llmGateway.actions.testUnsaved")}
        </Button>,
        <Button
          key="models"
          onClick={() => void listModelsUnsavedConfig("edit")}
          disabled={!editing}
          loading={loadingModels === DRAFT_EDIT_KEY}
        >
          {t("settings.llmGateway.actions.models")}
        </Button>,
        <Button
          key="cancel"
          onClick={() => {
            setEditing(null);
          }}
        >
          {t("common.cancel")}
        </Button>,
        <Button
          key="save"
          type="primary"
          onClick={() => editForm.submit()}
          loading={saving}
        >
          {t("common.save")}
        </Button>,
      ]}
    >
      <Form
        name="llm-gateway-edit"
        form={editForm}
        layout="vertical"
        onFinish={handleUpdate}
      >
        <Form.Item
          label={t("settings.llmGateway.fields.name")}
          name="name"
          rules={[
            {
              required: true,
              message: t("settings.llmGateway.validation.nameRequired"),
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.apiBase")}
          name="apiBase"
          extra={t("settings.llmGateway.hints.apiBase")}
          rules={apiBaseRules}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.apiKey")}
          name="apiKey"
          extra={t("settings.llmGateway.hints.apiKeyEdit")}
        >
          <Input.Password
            placeholder={t("settings.llmGateway.placeholders.apiKeyEdit")}
            disabled={Boolean(editClearApiKey)}
          />
        </Form.Item>
        <Form.Item name="clearApiKey" valuePropName="checked">
          <Switch
            checkedChildren={t("settings.llmGateway.actions.clearKey")}
            unCheckedChildren={t("settings.llmGateway.actions.keepKey")}
            onChange={(checked) => {
              if (checked) {
                editForm.setFieldsValue({ apiKey: "" });
              }
            }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.model")}
          name="model"
          extra={t("settings.llmGateway.hints.modelOptional")}
        >
          <Input allowClear />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.assistantModel")}
          name="assistantModel"
          extra={t("settings.llmGateway.hints.assistantModel")}
        >
          <Input allowClear />
        </Form.Item>
        <Form.Item
          name="assistantWebSearchEnabled"
          valuePropName="checked"
          label={t("settings.llmGateway.fields.assistantWebSearchEnabled")}
          extra={
            editAssistantWebSearchDisabled
              ? t(
                  "settings.llmGateway.hints.assistantWebSearchRequiresResponses",
                )
              : t("settings.llmGateway.hints.assistantWebSearchEnabled")
          }
        >
          <Switch disabled={editAssistantWebSearchDisabled} />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.embeddingModel")}
          name="embeddingModel"
        >
          <Input allowClear />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.rerankModel")}
          name="rerankModel"
          extra={t("settings.llmGateway.hints.rerankModel")}
        >
          <Input allowClear />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.rerankFallbackModels")}
          name="rerankFallbackModels"
          extra={t("settings.llmGateway.hints.rerankFallbackModels")}
        >
          <Input
            placeholder={t(
              "settings.llmGateway.placeholders.rerankFallbackModels",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.llmGateway.fields.apiSurface")}
          name="apiSurface"
          extra={t("settings.llmGateway.hints.apiSurface")}
        >
          <Select
            options={[
              { label: "chat_completions", value: "chat_completions" },
              { label: "responses", value: "responses" },
            ]}
          />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("settings.llmGateway.fields.timeoutMs")}
            name="timeoutMs"
            rules={[
              {
                required: true,
                message: t("settings.llmGateway.validation.timeoutRequired"),
              },
            ]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={1_000}
              max={900_000}
              step={1_000}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.maxRetries")}
            name="maxRetries"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.validation.maxRetriesRequired",
                ),
              },
            ]}
            style={{ minWidth: 160, flex: 1 }}
          >
            <InputNumber
              min={1}
              max={20}
              step={1}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Space>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("settings.llmGateway.fields.temperature")}
            name="temperature"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.validation.temperatureRequired",
                ),
              },
            ]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={0}
              max={2}
              step={0.1}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.topP")}
            name="topP"
            rules={[
              {
                required: true,
                message: t("settings.llmGateway.validation.topPRequired"),
              },
            ]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.maxOutputTokens")}
            name="maxOutputTokens"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.validation.maxOutputTokensRequired",
                ),
              },
            ]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber
              min={1}
              max={MAX_LLM_GATEWAY_OUTPUT_TOKENS}
              step={50}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.llmGateway.fields.fallbackModels")}
          name="fallbackModels"
          extra={t("settings.llmGateway.hints.fallbackModels")}
        >
          <Input />
        </Form.Item>

        <Form.Item
          label={
            <span>
              {t("settings.llmGateway.fields.responseFormatMode")}
              <Tooltip
                title={t("settings.llmGateway.tooltips.responseFormatMode")}
              >
                <QuestionCircleOutlined style={helpIconStyle} />
              </Tooltip>
            </span>
          }
          name="responseFormatMode"
          extra={t("settings.llmGateway.hints.responseFormatMode")}
        >
          <Select
            options={[
              { label: "json_schema", value: "json_schema" },
              { label: "json_object", value: "json_object" },
              { label: "none", value: "none" },
            ]}
          />
        </Form.Item>

        <Form.Item
          name="sendMetadata"
          valuePropName="checked"
          label={
            <span>
              {t("settings.llmGateway.fields.sendMetadata")}
              <Tooltip
                title={t("settings.llmGateway.tooltips.sendMetadata")}
              >
                <QuestionCircleOutlined style={helpIconStyle} />
              </Tooltip>
            </span>
          }
          extra={t("settings.llmGateway.hints.sendMetadata")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="enabled"
          valuePropName="checked"
          label={t("settings.llmGateway.fields.enabled")}
        >
          <Switch />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={
        testProfile
          ? t("settings.llmGateway.test.modal.title", {
              name: testProfile.name,
            })
          : undefined
      }
      open={Boolean(testProfile)}
      onCancel={closeTest}
      width={screens.md ? 720 : "100%"}
      destroyOnHidden
      footer={[
        <Button
          key="models"
          onClick={() => {
            if (testProfile) {
              void handleListModels(testProfile);
            }
          }}
          disabled={!testProfile}
          loading={testProfile ? loadingModels === testProfile.id : false}
        >
          {t("settings.llmGateway.actions.models")}
        </Button>,
        <Button key="close" onClick={closeTest}>
          {t("common.close")}
        </Button>,
        <Button
          key="run"
          type="primary"
          onClick={() => testForm.submit()}
          disabled={!testProfile}
          loading={testProfile ? testing === testProfile.id : false}
        >
          {t("settings.llmGateway.test.actions.run")}
        </Button>,
      ]}
    >
      <Form
        name="llm-gateway-test"
        form={testForm}
        layout="vertical"
        onFinish={(values) => {
          if (!testProfile) {
            return;
          }
          void runTest(testProfile.id, values);
        }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {t("settings.llmGateway.fields.apiBase")}:{" "}
          <Typography.Text code copyable>
            {testProfile?.apiBase ?? "-"}
          </Typography.Text>
        </Typography.Paragraph>

        <Form.Item
          label={t("settings.llmGateway.test.fields.authMode")}
          name="authMode"
          extra={t("settings.llmGateway.test.hints.authMode")}
        >
          <Select
            options={[
              {
                label: "profile_key",
                value: "profile_key",
              },
              {
                label: "managed_runtime_key",
                value: "managed_runtime_key",
                disabled: !testProfileCanUseManagedRuntimeKey,
              },
            ]}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.includeCompletion")}
          name="includeCompletion"
          valuePropName="checked"
          extra={t("settings.llmGateway.test.hints.includeCompletion")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.model")}
          name="model"
          extra={t("settings.llmGateway.test.hints.model")}
        >
          <Input
            allowClear
            disabled={!includeCompletion}
            placeholder={testProfile?.model ?? ""}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.prompt")}
          name="prompt"
        >
          <Input.TextArea
            placeholder={t("settings.llmGateway.test.placeholders.prompt")}
            autoSize={{ minRows: 2, maxRows: 6 }}
            disabled={!includeCompletion}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.apiSurface")}
          name="apiSurface"
        >
          <Select
            options={[
              { label: "chat_completions", value: "chat_completions" },
              { label: "responses", value: "responses" },
            ]}
            disabled={!includeCompletion}
          />
        </Form.Item>

        <Form.Item
          label={
            <span>
              {t("settings.llmGateway.test.fields.responseFormatMode")}
              <Tooltip
                title={t("settings.llmGateway.tooltips.responseFormatMode")}
              >
                <QuestionCircleOutlined style={helpIconStyle} />
              </Tooltip>
            </span>
          }
          name="responseFormatMode"
        >
          <Select
            options={[
              { label: "none", value: "none" },
              { label: "json_object", value: "json_object" },
              { label: "json_schema", value: "json_schema" },
            ]}
            disabled={!includeCompletion}
          />
        </Form.Item>

        <Form.Item
          label={
            <span>
              {t("settings.llmGateway.test.fields.includeMetadataProbe")}
              <Tooltip
                title={t("settings.llmGateway.tooltips.sendMetadata")}
              >
                <QuestionCircleOutlined style={helpIconStyle} />
              </Tooltip>
            </span>
          }
          name="includeMetadataProbe"
          valuePropName="checked"
        >
          <Switch disabled={!includeCompletion} />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.includeEmbeddings")}
          name="includeEmbeddings"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.embeddingModel")}
          name="embeddingModel"
          extra={t("settings.llmGateway.test.hints.embeddingModel")}
        >
          <Input
            allowClear
            disabled={!includeEmbeddings}
            placeholder={testProfile?.embeddingModel ?? ""}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.embeddingInput")}
          name="embeddingInput"
        >
          <Input
            disabled={!includeEmbeddings}
            placeholder={t(
              "settings.llmGateway.test.placeholders.embeddingInput",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.includeRerank")}
          name="includeRerank"
          valuePropName="checked"
          extra={t("settings.llmGateway.test.hints.includeRerank")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.rerankModel")}
          name="rerankModel"
          extra={t("settings.llmGateway.test.hints.rerankModel")}
        >
          <Input
            allowClear
            disabled={!includeRerank}
            placeholder={testProfile?.rerankModel ?? ""}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.rerankQuery")}
          name="rerankQuery"
        >
          <Input
            disabled={!includeRerank}
            placeholder={t(
              "settings.llmGateway.test.placeholders.rerankQuery",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.llmGateway.test.fields.rerankDocuments")}
          name="rerankDocuments"
        >
          <Input.TextArea
            disabled={!includeRerank}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t(
              "settings.llmGateway.test.placeholders.rerankDocuments",
            )}
          />
        </Form.Item>
      </Form>

      {testErrorMessage ? (
        <Alert
          type="error"
          showIcon
          message={testErrorMessage}
          style={{ marginTop: 12 }}
        />
      ) : null}

      {testResult ? (
        <div style={{ marginTop: 12 }}>{renderTestResult(testResult)}</div>
      ) : null}
    </Modal>

    </>
  );
}
