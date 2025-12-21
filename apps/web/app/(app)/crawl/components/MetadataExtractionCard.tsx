"use client";

import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { FormInstance } from "antd/es/form";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";

import type { CrawlMetadataQuery } from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import type { MetadataFormValues } from "../types";

type MetadataResultRow = CrawlMetadataQuery["crawlMetadata"][number];

interface MetadataExtractionCardProps {
  form: FormInstance<MetadataFormValues>;
  loading: boolean;
  results: MetadataResultRow[];
  onSubmit: () => Promise<void>;
}

export function MetadataExtractionCard({
  form,
  loading,
  results,
  onSubmit,
}: MetadataExtractionCardProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const metadataSource = Form.useWatch("source", form) ?? "sitemap";

  const metadataColumns: ColumnsType<MetadataResultRow> = [
    {
      title: t("crawl.metadata.columns.url"),
      dataIndex: "url",
      key: "url",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Link href={record.url} target="_blank">
            {record.url}
          </Typography.Link>
          {record.fetchedAt ? (
            <Typography.Text type="secondary">
              {formatDateTime(record.fetchedAt, locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("crawl.metadata.columns.status"),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (_: unknown, record) => (
        <Tag color={record.status === "success" ? "green" : "red"}>
          {t(`crawl.metadata.status.${record.status}`, {
            defaultValue: record.status.toUpperCase()
          })}
        </Tag>
      ),
    },
    {
      title: t("crawl.metadata.columns.http"),
      dataIndex: "httpStatus",
      key: "httpStatus",
      width: 90,
      render: (value: number | undefined) => value ?? t("common.emptyValue"),
    },
    {
      title: t("crawl.metadata.columns.score"),
      dataIndex: "relevanceScore",
      key: "relevanceScore",
      width: 100,
      render: (value: number | undefined | null) =>
        value !== null && value !== undefined ? value.toFixed(2) : t("common.emptyValue"),
    },
    {
      title: t("crawl.metadata.columns.summary"),
      key: "summary",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>
            {record.title ?? t("crawl.metadata.untitled")}
          </Typography.Text>
          <Typography.Text type="secondary">
            {record.description ?? t("crawl.metadata.noDescription")}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("crawl.metadata.columns.keywords"),
      dataIndex: "keywords",
      key: "keywords",
      render: (_: unknown, record) =>
        record.keywords && record.keywords.length > 0 ? (
          <Space wrap>
            {record.keywords.slice(0, 4).map((keyword) => (
              <Tag key={`${record.url}-kw-${keyword}`}>{keyword}</Tag>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        ),
    },
    {
      title: t("crawl.metadata.columns.metadata"),
      key: "metadata",
      render: (_: unknown, record) => {
        const primaryMeta = record.metaTags.slice(0, 2);
        const primaryOg = record.openGraph.slice(0, 2);
        return (
          <Space direction="vertical" size={4}>
            {primaryMeta.length > 0 ? (
              <Space wrap>
                {primaryMeta.map((tag) => (
                  <Tag key={`${record.url}-meta-${tag.name}`} color="blue">
                    {tag.name}: {tag.value}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {t("crawl.metadata.noMetaTags")}
              </Typography.Text>
            )}
            {primaryOg.length > 0 ? (
              <Space wrap>
                {primaryOg.map((tag) => (
                  <Tag key={`${record.url}-og-${tag.name}`} color="purple">
                    {tag.name}: {tag.value}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {t("crawl.metadata.noOpenGraph")}
              </Typography.Text>
            )}
            {record.jsonLd.length > 0 ? (
              <Tag color="geekblue">
                {t("crawl.metadata.jsonLdCount", { count: record.jsonLd.length })}
              </Tag>
            ) : (
              <Typography.Text type="secondary">{t("crawl.metadata.noJsonLd")}</Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: t("crawl.metadata.columns.error"),
      dataIndex: "error",
      key: "error",
      render: (value: string | undefined | null) => value ?? t("common.emptyValue"),
    },
  ];

  return (
    <Card title={t("crawl.metadata.title")} style={{ marginTop: 24 }}>
      <Typography.Paragraph type="secondary">
        {t("crawl.metadata.description")}{" "}
        <Typography.Link
          href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/url-seeding.md"
          target="_blank"
          rel="noreferrer"
        >
          {t("crawl.metadata.linkText")}
        </Typography.Link>
        {t("common.punctuation.period")}
      </Typography.Paragraph>
      <Form
        layout="vertical"
        form={form}
        onFinish={onSubmit}
        initialValues={{ source: "sitemap", maxUrls: 10 }}
        style={{ marginTop: 16 }}
      >
        <Space align="end" wrap>
          <Form.Item
            label={t("crawl.metadata.fields.source")}
            name="source"
            style={{ minWidth: 200 }}
            rules={[{ required: true, message: t("crawl.metadata.errors.sourceRequired") }]}
          >
            <Select
              options={[
                { label: t("crawl.metadata.source.sitemap"), value: "sitemap" },
                { label: t("crawl.metadata.source.urls"), value: "urls" },
              ]}
            />
          </Form.Item>
          {metadataSource === "sitemap" ? (
            <>
              <Form.Item
                label={t("crawl.metadata.fields.domain")}
                name="domain"
                style={{ minWidth: 220 }}
                rules={[{ required: true, message: t("crawl.metadata.errors.domainRequired") }]}
              >
                <Input placeholder={t("crawl.metadata.placeholders.domain")} />
              </Form.Item>
              <Form.Item
                label={t("crawl.metadata.fields.pattern")}
                name="pattern"
                style={{ minWidth: 200 }}
              >
                <Input placeholder={t("crawl.metadata.placeholders.pattern")} />
              </Form.Item>
              <Form.Item label={t("crawl.metadata.fields.maxUrls")} name="maxUrls">
                <InputNumber min={1} max={200} style={{ width: 120 }} />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              label={t("crawl.metadata.fields.urls")}
              name="urls"
              style={{ minWidth: 320 }}
              rules={[{ required: true, message: t("crawl.metadata.errors.urlsRequired") }]}
            >
              <Input.TextArea
                rows={4}
                placeholder={t("crawl.metadata.placeholders.urls")}
              />
            </Form.Item>
          )}
          <Form.Item label={t("crawl.metadata.fields.query")} name="query" style={{ minWidth: 220 }}>
            <Input placeholder={t("crawl.metadata.placeholders.query")} />
          </Form.Item>
          <Form.Item label={t("crawl.metadata.fields.scoreThreshold")} name="scoreThreshold">
            <InputNumber
              min={0}
              max={1}
              step={0.1}
              style={{ width: 140 }}
              placeholder={t("crawl.metadata.placeholders.scoreThreshold")}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>
              {t("crawl.metadata.submit")}
            </Button>
          </Form.Item>
        </Space>
      </Form>
      <Table<MetadataResultRow>
        style={{ marginTop: 24 }}
        rowKey={(record) =>
          `${record.url}-${record.fetchedAt ?? record.status}`
        }
        columns={metadataColumns}
        dataSource={results}
        loading={loading}
        pagination={false}
        locale={{ emptyText: t("crawl.metadata.empty") }}
      />
    </Card>
  );
}
