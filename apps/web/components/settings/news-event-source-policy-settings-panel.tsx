"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Form,
  Select,
  Space,
  Spin,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

interface NewsEventSourcePolicyModel {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
}

interface QueryData {
  newsEventSourcePolicy: NewsEventSourcePolicyModel;
}

interface MutationData {
  updateNewsEventSourcePolicy: NewsEventSourcePolicyModel;
}

interface FormValues {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
}

const NEWS_EVENT_SOURCE_POLICY_QUERY = gql`
  query NewsEventSourcePolicy {
    newsEventSourcePolicy {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
    }
  }
`;

const UPDATE_NEWS_EVENT_SOURCE_POLICY_MUTATION = gql`
  mutation UpdateNewsEventSourcePolicy(
    $input: UpdateNewsEventSourcePolicyInput!
  ) {
    updateNewsEventSourcePolicy(input: $input) {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
    }
  }
`;

const TAG_TOKEN_SEPARATORS = [",", "\n", "\t"];

function normalizeTokenList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = values
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized)).slice(0, 1000);
}

export function NewsEventSourcePolicySettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();

  const { data, loading, refetch, error } = useQuery<QueryData>(
    NEWS_EVENT_SOURCE_POLICY_QUERY,
    {
      fetchPolicy: "cache-and-network",
    },
  );

  const [updatePolicy, { loading: saving }] = useMutation<MutationData>(
    UPDATE_NEWS_EVENT_SOURCE_POLICY_MUTATION,
  );

  useEffect(() => {
    if (data?.newsEventSourcePolicy) {
      form.setFieldsValue(data.newsEventSourcePolicy);
    }
  }, [data?.newsEventSourcePolicy, form]);

  const authoritativeDomainOptions = Form.useWatch(
    "authoritativeDomains",
    form,
  );
  const authoritativeLabelOptions = Form.useWatch("authoritativeLabels", form);
  const blogDomainOptions = Form.useWatch("blogDomains", form);
  const blogLabelOptions = Form.useWatch("blogLabels", form);

  const toOptions = useMemo(
    () => (values: unknown) =>
      normalizeTokenList(values).map((value) => ({ label: value, value })),
    [],
  );

  const handleSubmit = async (values: FormValues) => {
    const payload: FormValues = {
      authoritativeDomains: normalizeTokenList(values.authoritativeDomains),
      authoritativeLabels: normalizeTokenList(values.authoritativeLabels),
      blogDomains: normalizeTokenList(values.blogDomains),
      blogLabels: normalizeTokenList(values.blogLabels),
    };

    try {
      await updatePolicy({ variables: { input: payload } });
      await refetch();
      messageApi.success(
        t("settings.newsEventSourcePolicy.messages.saved", {
          defaultValue: "Saved",
        }),
      );
    } catch (err) {
      captureClientError("Failed to save news event source policy", err);
      messageApi.error(
        t("settings.newsEventSourcePolicy.messages.saveFailed", {
          defaultValue: "Failed to save",
        }),
      );
    }
  };

  if (loading && !data?.newsEventSourcePolicy) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("settings.newsEventSourcePolicy.description", {
          defaultValue:
            "Maintain authoritative and low-trust source lists for timeline authority filtering. Changes take effect on the next event query.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsEventSourcePolicy.notice.title", {
          defaultValue: "Real-time effect",
        })}
        description={t("settings.newsEventSourcePolicy.notice.body", {
          defaultValue:
            "After saving, source classification is refreshed immediately in backend cache and applied to newly fetched timeline events.",
        })}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsEventSourcePolicy.messages.loadFailed", {
            defaultValue: "Failed to load source policy",
          })}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t(
            "settings.newsEventSourcePolicy.fields.authoritativeDomains",
            {
              defaultValue: "Authoritative domains whitelist",
            },
          )}
          name="authoritativeDomains"
          extra={t(
            "settings.newsEventSourcePolicy.hints.authoritativeDomains",
            {
              defaultValue: "Examples: reuters.com, bloomberg.com, ft.com",
            },
          )}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(authoritativeDomainOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.authoritativeDomains",
              {
                defaultValue: "Enter domains",
              },
            )}
          />
        </Form.Item>

        <Form.Item
          label={t(
            "settings.newsEventSourcePolicy.fields.authoritativeLabels",
            {
              defaultValue: "Authoritative source labels whitelist",
            },
          )}
          name="authoritativeLabels"
          extra={t("settings.newsEventSourcePolicy.hints.authoritativeLabels", {
            defaultValue:
              "Examples: Reuters, Financial Times, Associated Press",
          })}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(authoritativeLabelOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.authoritativeLabels",
              {
                defaultValue: "Enter source labels",
              },
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.blogDomains", {
            defaultValue: "Blog/Social domains blacklist",
          })}
          name="blogDomains"
          extra={t("settings.newsEventSourcePolicy.hints.blogDomains", {
            defaultValue: "Examples: medium.com, substack.com, x.com",
          })}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(blogDomainOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.blogDomains",
              {
                defaultValue: "Enter domains",
              },
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.blogLabels", {
            defaultValue: "Blog/Social source labels blacklist",
          })}
          name="blogLabels"
          extra={t("settings.newsEventSourcePolicy.hints.blogLabels", {
            defaultValue: "Examples: newsletter, creator, influencer",
          })}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(blogLabelOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.blogLabels",
              {
                defaultValue: "Enter source labels",
              },
            )}
          />
        </Form.Item>

        <Space>
          <Button
            type="primary"
            htmlType="submit"
            loading={saving}
            disabled={loading}
          >
            {t("common.saveChanges", { defaultValue: "Save changes" })}
          </Button>
          <Button onClick={() => void refetch()}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        </Space>
      </Form>
    </>
  );
}
