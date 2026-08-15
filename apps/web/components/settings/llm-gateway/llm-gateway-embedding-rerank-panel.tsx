"use client";

import { Alert, Card, Form, Select, Space, Tag, Typography } from "antd";
import type { ReactElement } from "react";

import {
  FOLLOW_COMPLETION_KEY,
  USE_DEFAULT_KEY,
} from "./llm-gateway.types";
import type { LlmGatewaySettingsController } from "./use-llm-gateway-settings";

export function LlmGatewayEmbeddingRerankPanel({
  s,
}: {
  s: LlmGatewaySettingsController;
}): ReactElement {
  const {
    t,
    settings,
    completionActiveProfile,
    embeddingResolved,
    embeddingActiveProfile,
    embeddingSelectValue,
    embeddingActivating,
    handleActivateEmbedding,
    rerankResolved,
    rerankActiveProfile,
    rerankSelectValue,
    rerankActivating,
    handleActivateRerank,
    loading,
  } = s;

  return (
    <Space direction="vertical" size="middle" style={{ display: "flex" }}>
    <Card
      size="small"
      title={t("settings.llmGateway.embeddingActive.title")}
    >
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Text type="secondary">
          {t("settings.llmGateway.embeddingActive.hint")}
        </Typography.Text>

        <Typography.Text type="secondary">
          {t("settings.llmGateway.embeddingActive.currentCompletion")}
          :{" "}
          {completionActiveProfile ? (
            <Typography.Text>
              {completionActiveProfile.name}{" "}
              <Typography.Text code copyable>
                {completionActiveProfile.model}
              </Typography.Text>
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Typography.Text>

        <Typography.Text type="secondary">
          {t("settings.llmGateway.embeddingActive.currentEmbedding")}
          :{" "}
          {embeddingResolved.kind === "default" ? (
            <Space size={6} wrap>
              <Typography.Text>
                {t("settings.llmGateway.embeddingActive.default")}
              </Typography.Text>
              <Tag>
                {t("settings.llmGateway.embeddingActive.defaultTag")}
              </Tag>
            </Space>
          ) : embeddingActiveProfile ? (
            <Space size={6} wrap>
              <Typography.Text>
                {embeddingActiveProfile.name}
              </Typography.Text>
              {settings.embeddingActiveId ? (
                settings.embeddingActiveId === settings.activeId ? (
                  <Tag color="purple">
                    {t("settings.llmGateway.embeddingActive.lockedSame")}
                  </Tag>
                ) : (
                  <Tag color="purple">
                    {t("settings.llmGateway.embeddingActive.independent")}
                  </Tag>
                )
              ) : completionActiveProfile ? (
                <Tag>
                  {t("settings.llmGateway.embeddingActive.following")}
                </Tag>
              ) : (
                <Tag>
                  {t("settings.llmGateway.embeddingActive.default")}
                </Tag>
              )}
              {embeddingActiveProfile.embeddingModel ? (
                <Typography.Text code copyable>
                  {embeddingActiveProfile.embeddingModel}
                </Typography.Text>
              ) : embeddingResolved.kind === "follow_completion" ? (
                <Tag>
                  {t(
                    "settings.llmGateway.embeddingActive.inheritEmbeddingModel",
                  )}
                </Tag>
              ) : (
                <Tag color="red">
                  {t(
                    "settings.llmGateway.embeddingActive.missingEmbeddingModel",
                  )}
                </Tag>
              )}
            </Space>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Typography.Text>

        <Form layout="inline" style={{ width: "100%" }}>
          <Form.Item
            label={t("settings.llmGateway.embeddingActive.selectLabel")}
            style={{ flex: 1, minWidth: 260 }}
          >
            <Select
              value={embeddingSelectValue}
              placeholder={t(
                "settings.llmGateway.embeddingActive.selectPlaceholder",
              )}
              loading={loading || embeddingActivating}
              options={[
                {
                  value: FOLLOW_COMPLETION_KEY,
                  label: (
                    <Space size={6} wrap>
                      <Typography.Text>
                        {completionActiveProfile
                          ? t(
                              "settings.llmGateway.embeddingActive.followCompletion",
                              {
                                name: completionActiveProfile.name,
                              },
                            )
                          : t(
                              "settings.llmGateway.embeddingActive.followCompletionEmpty",
                            )}
                      </Typography.Text>
                      <Tag>
                        {t(
                          "settings.llmGateway.embeddingActive.followTag",
                        )}
                      </Tag>
                    </Space>
                  ),
                },
                {
                  value: USE_DEFAULT_KEY,
                  label: (
                    <Space size={6} wrap>
                      <Typography.Text>
                        {t(
                          "settings.llmGateway.embeddingActive.useDefault",
                        )}
                      </Typography.Text>
                      <Tag>
                        {t(
                          "settings.llmGateway.embeddingActive.defaultTag",
                        )}
                      </Tag>
                    </Space>
                  ),
                },
                ...settings.profiles.map((profile) => ({
                  value: profile.id,
                  disabled: !profile.enabled || !profile.embeddingModel,
                  label: (
                    <Space size={6} wrap>
                      <Typography.Text>{profile.name}</Typography.Text>
                      {!profile.enabled ? (
                        <Tag color="red">{t("common.disabled")}</Tag>
                      ) : !profile.embeddingModel ? (
                        <Tag color="red">
                          {t(
                            "settings.llmGateway.embeddingActive.missingEmbeddingModelShort",
                          )}
                        </Tag>
                      ) : (
                        <Tag color="purple">
                          {t("settings.llmGateway.embeddingActive.tag")}
                        </Tag>
                      )}
                    </Space>
                  ),
                })),
              ]}
              onChange={(value) => {
                if (value === FOLLOW_COMPLETION_KEY) {
                  void handleActivateEmbedding(null, "follow_completion");
                  return;
                }
                if (value === USE_DEFAULT_KEY) {
                  void handleActivateEmbedding(null, "use_default");
                  return;
                }
                void handleActivateEmbedding(value);
              }}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>

        {embeddingActiveProfile ? (
          <>
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0 }}
            >
              {t("settings.llmGateway.fields.apiBase")}:{" "}
              <Typography.Text code copyable>
                {embeddingActiveProfile.apiBase}
              </Typography.Text>
            </Typography.Paragraph>
            <Space wrap>
              <Tag color={embeddingActiveProfile.enabled ? "green" : "red"}>
                {embeddingActiveProfile.enabled
                  ? t("common.enabled")
                  : t("common.disabled")}
              </Tag>
              <Tag
                color={
                  embeddingActiveProfile.hasApiKey ? "green" : "default"
                }
              >
                {embeddingActiveProfile.hasApiKey
                  ? t("settings.llmGateway.keySet")
                  : t("settings.llmGateway.keyMissing")}
              </Tag>
            </Space>
          </>
        ) : null}

        {!settings.profiles.some(
          (profile) => profile.enabled && profile.embeddingModel,
        ) ? (
          <Alert
            type="warning"
            showIcon
            message={t(
              "settings.llmGateway.embeddingActive.noEligibleProfiles",
            )}
          />
        ) : null}
      </Space>
    </Card>

    <Card
      size="small"
      title={t("settings.llmGateway.rerankActive.title")}
    >
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Text type="secondary">
          {t("settings.llmGateway.rerankActive.hint")}
        </Typography.Text>

        <Typography.Text type="secondary">
          {t("settings.llmGateway.rerankActive.currentCompletion")}
          :{" "}
          {completionActiveProfile ? (
            <Typography.Text>
              {completionActiveProfile.name}{" "}
              <Typography.Text code copyable>
                {completionActiveProfile.model}
              </Typography.Text>
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Typography.Text>

        <Typography.Text type="secondary">
          {t("settings.llmGateway.rerankActive.currentRerank")}
          :{" "}
          {rerankResolved.kind === "default" ? (
            <Space size={6} wrap>
              <Typography.Text>
                {t("settings.llmGateway.rerankActive.default")}
              </Typography.Text>
              <Tag>
                {t("settings.llmGateway.rerankActive.defaultTag")}
              </Tag>
            </Space>
          ) : rerankActiveProfile ? (
            <Space size={6} wrap>
              <Typography.Text>{rerankActiveProfile.name}</Typography.Text>
              {settings.rerankActiveId ? (
                settings.rerankActiveId === settings.activeId ? (
                  <Tag color="gold">
                    {t("settings.llmGateway.rerankActive.lockedSame")}
                  </Tag>
                ) : (
                  <Tag color="gold">
                    {t("settings.llmGateway.rerankActive.independent")}
                  </Tag>
                )
              ) : completionActiveProfile ? (
                <Tag>
                  {t("settings.llmGateway.rerankActive.following")}
                </Tag>
              ) : (
                <Tag>
                  {t("settings.llmGateway.rerankActive.default")}
                </Tag>
              )}
              {rerankActiveProfile.rerankModel ? (
                <Typography.Text code copyable>
                  {rerankActiveProfile.rerankModel}
                </Typography.Text>
              ) : (
                <Tag color="red">
                  {t(
                    "settings.llmGateway.rerankActive.missingRerankModel",
                  )}
                </Tag>
              )}
            </Space>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Typography.Text>

        <Form layout="inline" style={{ width: "100%" }}>
          <Form.Item
            label={t("settings.llmGateway.rerankActive.selectLabel")}
            style={{ flex: 1, minWidth: 260 }}
          >
            <Select
              value={rerankSelectValue}
              placeholder={t(
                "settings.llmGateway.rerankActive.selectPlaceholder",
              )}
              loading={loading || rerankActivating}
              options={[
                {
                  value: FOLLOW_COMPLETION_KEY,
                  label: (
                    <Space size={6} wrap>
                      <Typography.Text>
                        {completionActiveProfile
                          ? t(
                              "settings.llmGateway.rerankActive.followCompletion",
                              {
                                name: completionActiveProfile.name,
                              },
                            )
                          : t(
                              "settings.llmGateway.rerankActive.followCompletionEmpty",
                            )}
                      </Typography.Text>
                      <Tag>
                        {t("settings.llmGateway.rerankActive.followTag")}
                      </Tag>
                    </Space>
                  ),
                },
                {
                  value: USE_DEFAULT_KEY,
                  label: (
                    <Space size={6} wrap>
                      <Typography.Text>
                        {t("settings.llmGateway.rerankActive.useDefault")}
                      </Typography.Text>
                      <Tag>
                        {t("settings.llmGateway.rerankActive.defaultTag")}
                      </Tag>
                    </Space>
                  ),
                },
                ...settings.profiles.map((profile) => ({
                  value: profile.id,
                  disabled: !profile.enabled || !profile.rerankModel,
                  label: (
                    <Space size={6} wrap>
                      <Typography.Text>{profile.name}</Typography.Text>
                      {!profile.enabled ? (
                        <Tag color="red">{t("common.disabled")}</Tag>
                      ) : !profile.rerankModel ? (
                        <Tag color="red">
                          {t(
                            "settings.llmGateway.rerankActive.missingRerankModelShort",
                          )}
                        </Tag>
                      ) : (
                        <Tag color="gold">
                          {t("settings.llmGateway.rerankActive.tag")}
                        </Tag>
                      )}
                    </Space>
                  ),
                })),
              ]}
              onChange={(value) => {
                if (value === FOLLOW_COMPLETION_KEY) {
                  void handleActivateRerank(null, "follow_completion");
                  return;
                }
                if (value === USE_DEFAULT_KEY) {
                  void handleActivateRerank(null, "use_default");
                  return;
                }
                void handleActivateRerank(value);
              }}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>

        {rerankActiveProfile ? (
          <>
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0 }}
            >
              {t("settings.llmGateway.fields.apiBase")}:{" "}
              <Typography.Text code copyable>
                {rerankActiveProfile.apiBase}
              </Typography.Text>
            </Typography.Paragraph>
            <Space wrap>
              <Tag color={rerankActiveProfile.enabled ? "green" : "red"}>
                {rerankActiveProfile.enabled
                  ? t("common.enabled")
                  : t("common.disabled")}
              </Tag>
              <Tag
                color={rerankActiveProfile.hasApiKey ? "green" : "default"}
              >
                {rerankActiveProfile.hasApiKey
                  ? t("settings.llmGateway.keySet")
                  : t("settings.llmGateway.keyMissing")}
              </Tag>
            </Space>
          </>
        ) : null}

        {!settings.profiles.some(
          (profile) => profile.enabled && profile.rerankModel,
        ) ? (
          <Alert
            type="warning"
            showIcon
            message={t(
              "settings.llmGateway.rerankActive.noEligibleProfiles",
            )}
          />
        ) : null}
      </Space>
    </Card>
    </Space>
  );
}
