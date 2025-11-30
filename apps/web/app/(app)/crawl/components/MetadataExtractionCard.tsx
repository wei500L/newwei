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
import type { ColumnsType } from "antd/es/table";
import type { FormInstance } from "antd/es/form";
import dayjs from "dayjs";
import type {
  CrawlMetadataInput,
  CrawlMetadataQuery,
} from "@/graphql/generated";
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
  const metadataSource = Form.useWatch("source", form) ?? "sitemap";

  const metadataColumns: ColumnsType<MetadataResultRow> = [
    {
      title: "URL",
      dataIndex: "url",
      key: "url",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Link href={record.url} target="_blank">
            {record.url}
          </Typography.Link>
          {record.fetchedAt ? (
            <Typography.Text type="secondary">
              {dayjs(record.fetchedAt).format("MMM D, HH:mm")}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (_: unknown, record) => (
        <Tag color={record.status === "success" ? "green" : "red"}>
          {record.status.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: "HTTP",
      dataIndex: "httpStatus",
      key: "httpStatus",
      width: 90,
      render: (value: number | undefined) => value ?? "—",
    },
    {
      title: "Score",
      dataIndex: "relevanceScore",
      key: "relevanceScore",
      width: 100,
      render: (value: number | undefined | null) =>
        value !== null && value !== undefined ? value.toFixed(2) : "—",
    },
    {
      title: "Summary",
      key: "summary",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>
            {record.title ?? "Untitled page"}
          </Typography.Text>
          <Typography.Text type="secondary">
            {record.description ?? "No meta description provided"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "Keywords",
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
          "—"
        ),
    },
    {
      title: "Metadata",
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
                No standard meta tags
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
                No Open Graph tags
              </Typography.Text>
            )}
            {record.jsonLd.length > 0 ? (
              <Tag color="geekblue">
                {record.jsonLd.length} JSON-LD block(s)
              </Tag>
            ) : (
              <Typography.Text type="secondary">No JSON-LD</Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: "Error",
      dataIndex: "error",
      key: "error",
      render: (value: string | undefined | null) => value ?? "—",
    },
  ];

  return (
    <Card title="Metadata extraction" style={{ marginTop: 24 }}>
      <Typography.Paragraph type="secondary">
        Preview head metadata via sitemap seeding before creating a crawl task.
        Powered by{" "}
        <Typography.Link
          href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/url-seeding.md"
          target="_blank"
          rel="noreferrer"
        >
          crawl4ai&apos;s metadata extraction guidance
        </Typography.Link>
        .
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
            label="Source"
            name="source"
            style={{ minWidth: 200 }}
            rules={[{ required: true, message: "请选择来源" }]}
          >
            <Select
              options={[
                { label: "Sitemap seeding", value: "sitemap" },
                { label: "Manual URLs", value: "urls" },
              ]}
            />
          </Form.Item>
          {metadataSource === "sitemap" ? (
            <>
              <Form.Item
                label="Domain"
                name="domain"
                style={{ minWidth: 220 }}
                rules={[{ required: true, message: "请输入域名" }]}
              >
                <Input placeholder="news.example.com" />
              </Form.Item>
              <Form.Item
                label="Pattern"
                name="pattern"
                style={{ minWidth: 200 }}
              >
                <Input placeholder="*/blog/*" />
              </Form.Item>
              <Form.Item label="Max URLs" name="maxUrls">
                <InputNumber min={1} max={200} style={{ width: 120 }} />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              label="URLs"
              name="urls"
              style={{ minWidth: 320 }}
              rules={[{ required: true, message: "请输入 URL 列表" }]}
            >
              <Input.TextArea
                rows={4}
                placeholder="https://example.com/post-1"
              />
            </Form.Item>
          )}
          <Form.Item label="Query" name="query" style={{ minWidth: 220 }}>
            <Input placeholder="e.g. API reference" />
          </Form.Item>
          <Form.Item label="Score threshold" name="scoreThreshold">
            <InputNumber
              min={0}
              max={1}
              step={0.1}
              style={{ width: 140 }}
              placeholder="0.3"
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>
              Extract metadata
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
        locale={{ emptyText: "填写上方表单以预览 metadata" }}
      />
    </Card>
  );
}
