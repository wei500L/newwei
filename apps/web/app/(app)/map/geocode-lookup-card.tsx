"use client";

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface GeocodeBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface GeocodeResult {
  lat: number;
  lng: number;
  displayName?: string;
  bounds?: GeocodeBounds;
  provider: string;
  query: string;
  countryCodeAlpha2?: string;
}

interface GeocodeResponse {
  result: GeocodeResult | null;
}

interface GeocodeLookupValues {
  query: string;
  countryCodeAlpha2?: string;
}

export function GeocodeLookupCard() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [form] = Form.useForm<GeocodeLookupValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GeocodeResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const openStreetMapHref = result
    ? `https://www.openstreetmap.org/?mlat=${result.lat}&mlon=${result.lng}#map=7/${result.lat}/${result.lng}`
    : null;

  const handleSubmit = async (values: GeocodeLookupValues) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.post<GeocodeResponse>("geo/geocode", {
        query: values.query.trim(),
        ...(values.countryCodeAlpha2?.trim()
          ? { countryCodeAlpha2: values.countryCodeAlpha2.trim().toUpperCase() }
          : {}),
      });
      setResult(response.data?.result ?? null);
      if (!response.data?.result) {
        setErrorMessage(
          t("pages.map.geocode.empty"),
        );
      }
    } catch (error) {
      captureClientError("Failed to geocode location from map page", error);
      setResult(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("pages.map.geocode.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      className="content-card"
      title={t("pages.map.geocode.title")}
    >
      {contextHolder}
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          {t("pages.map.geocode.description")}
        </Typography.Text>

        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            void handleSubmit(values);
          }}
        >
          <Form.Item
            label={t("pages.map.geocode.fields.query")}
            name="query"
            rules={[
              {
                required: true,
                message: t("pages.map.geocode.validation.queryRequired"),
              },
            ]}
          >
            <Input
              placeholder={t("pages.map.geocode.placeholders.query")}
            />
          </Form.Item>

          <Form.Item
            label={t("pages.map.geocode.fields.countryCode")}
            name="countryCodeAlpha2"
          >
            <Input
              maxLength={2}
              placeholder={t("pages.map.geocode.placeholders.countryCode")}
            />
          </Form.Item>

          <Space wrap>
            <Button type="primary" htmlType="submit" loading={loading}>
              {t("pages.map.geocode.actions.lookup")}
            </Button>
            <Button
              onClick={() => {
                form.resetFields();
                setResult(null);
                setErrorMessage(null);
              }}
            >
              {t("common.reset")}
            </Button>
          </Space>
        </Form>

        {errorMessage ? (
          <Alert
            type={result ? "info" : "warning"}
            showIcon
            message={errorMessage}
          />
        ) : null}

        {result ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions bordered size="small" column={{ xs: 1, lg: 2 }}>
              <Descriptions.Item
                label={t("pages.map.geocode.labels.result")}
              >
                {result.displayName ?? result.query}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("pages.map.geocode.labels.provider")}
              >
                <Tag>{result.provider}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Lat">
                {result.lat.toFixed(6)}
              </Descriptions.Item>
              <Descriptions.Item label="Lng">
                {result.lng.toFixed(6)}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("pages.map.geocode.labels.country")}
              >
                {result.countryCodeAlpha2 ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("pages.map.geocode.labels.bounds")}
              >
                {result.bounds
                  ? `${result.bounds.minLat.toFixed(3)}, ${result.bounds.minLng.toFixed(3)} → ${result.bounds.maxLat.toFixed(3)}, ${result.bounds.maxLng.toFixed(3)}`
                  : t("common.notAvailable")}
              </Descriptions.Item>
            </Descriptions>

            <Space wrap>
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `${result.lat}, ${result.lng}`,
                    );
                    messageApi.success(
                      t("pages.map.geocode.messages.copied"),
                    );
                  } catch (error) {
                    captureClientError("Failed to copy geocode coordinates", error);
                    messageApi.error(
                      t("pages.map.geocode.messages.copyFailed"),
                    );
                  }
                }}
              >
                {t("pages.map.geocode.actions.copyCoordinates")}
              </Button>
              {openStreetMapHref ? (
                <Button href={openStreetMapHref} target="_blank" rel="noreferrer">
                  {t("pages.map.geocode.actions.openMap")}
                </Button>
              ) : null}
            </Space>
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}
