"use client";

import { DeleteOutlined, EditOutlined, EnvironmentOutlined, FileSearchOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Card, Form, Input, InputNumber, List, Modal, Popconfirm, Select, Space, Switch, Tabs, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import {
  useSituationMonitorMonitorsStore,
  type SituationMonitorCustomMonitor,
} from "@/store/situation-monitor-monitors";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";

interface MonitorFormValues {
  name: string;
  keywords: string[];
  color?: string;
  locationName?: string;
  locationLat?: number;
  locationLng?: number;
}

interface GeoGeocodeResponse {
  result: { lat: number; lng: number; displayName?: string } | null;
}

function buildTabsLabel(label: string, count: number, color?: string) {
  return (
    <Space size={8}>
      <span>{label}</span>
      <Tag color={color ?? "geekblue"} style={{ marginInlineEnd: 0 }}>
        {count}
      </Tag>
    </Space>
  );
}

export function SituationMonitorMonitorsPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const translateToZh = useSituationMonitorSettingsStore((state) => state.translateToZh);

  const monitors = useSituationMonitorMonitorsStore((state) => state.monitors);
  const matches = useSituationMonitorMonitorsStore((state) => state.matches);
  const matchCounts = useSituationMonitorMonitorsStore((state) => state.matchCounts);
  const addMonitor = useSituationMonitorMonitorsStore((state) => state.addMonitor);
  const updateMonitor = useSituationMonitorMonitorsStore((state) => state.updateMonitor);
  const deleteMonitor = useSituationMonitorMonitorsStore((state) => state.deleteMonitor);
  const toggleMonitor = useSituationMonitorMonitorsStore((state) => state.toggleMonitor);
  const clearMatches = useSituationMonitorMonitorsStore((state) => state.clearMatches);
  const reset = useSituationMonitorMonitorsStore((state) => state.reset);

  const [modalOpen, setModalOpen] = useState(false);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm<MonitorFormValues>();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const editingMonitor = useMemo(
    () => (editingId ? monitors.find((monitor) => monitor.id === editingId) ?? null : null),
    [editingId, monitors],
  );

  const sortedMonitors = useMemo(
    () => monitors.slice().sort((a, b) => b.createdAt - a.createdAt),
    [monitors],
  );

  const sortedMatches = useMemo(
    () => matches.slice().sort((a, b) => b.item.timestamp - a.item.timestamp),
    [matches],
  );

  const openCreate = () => {
    setEditingId(null);
    form.setFieldsValue({ name: "", keywords: [], color: undefined, locationName: undefined, locationLat: undefined, locationLng: undefined });
    setModalOpen(true);
  };

  const openEdit = (monitor: SituationMonitorCustomMonitor) => {
    setEditingId(monitor.id);
    form.setFieldsValue({
      name: monitor.name,
      keywords: monitor.keywords,
      color: monitor.color,
      locationName: monitor.location?.name,
      locationLat: monitor.location?.lat,
      locationLng: monitor.location?.lng
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingId(null);
    form.resetFields();
  };

  const resolveLocation = async () => {
    const nameRaw = form.getFieldValue("locationName");
    const query = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!query) {
      message.warning(
        t("situationMonitor.monitors.locationResolveMissing", {
          defaultValue: "Enter a location name first.",
        }),
      );
      return;
    }
    if (!session?.accessToken) {
      message.error(
        t("common.unauthorized", { defaultValue: "You are not signed in." }),
      );
      return;
    }

    setGeocodeLoading(true);
    try {
      const response = await apiClient.post<GeoGeocodeResponse>("geo/geocode", { query });
      const result = response.data?.result ?? null;
      if (!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
        message.warning(
          t("situationMonitor.monitors.locationResolveFailed", {
            defaultValue: "Could not resolve that location.",
          }),
        );
        return;
      }
      form.setFieldsValue({ locationLat: result.lat, locationLng: result.lng });
      message.success(
        t("situationMonitor.monitors.locationResolved", {
          defaultValue: "Location resolved.",
        }),
      );
    } catch {
      message.error(
        t("situationMonitor.monitors.locationResolveError", {
          defaultValue: "Failed to resolve location.",
        }),
      );
    } finally {
      setGeocodeLoading(false);
    }
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const locationName = typeof values.locationName === "string" ? values.locationName.trim() : "";
    const locationLat = typeof values.locationLat === "number" ? values.locationLat : Number.NaN;
    const locationLng = typeof values.locationLng === "number" ? values.locationLng : Number.NaN;
    const location =
      locationName && Number.isFinite(locationLat) && Number.isFinite(locationLng)
        ? { name: locationName, lat: locationLat, lng: locationLng }
        : null;
    const payload = { name: values.name, keywords: values.keywords, color: values.color ?? null, location };
    if (editingId) {
      const ok = updateMonitor(editingId, payload);
      if (!ok) {
        message.error(t("situationMonitor.monitors.updateFailed", { defaultValue: "Failed to update monitor." }));
        return;
      }
      message.success(t("situationMonitor.monitors.updated", { defaultValue: "Monitor updated." }));
      closeModal();
      return;
    }

    const created = addMonitor(payload);
    if (!created) {
      message.error(
        t("situationMonitor.monitors.addFailed", {
          defaultValue: "Could not add monitor (check name/keywords or max monitors reached).",
        }),
      );
      return;
    }
    message.success(t("situationMonitor.monitors.created", { defaultValue: "Monitor created." }));
    closeModal();
  };

  return (
    <Card
      title={t("situationMonitor.monitors.title", { defaultValue: "My Monitors" })}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      extra={
        <Space size="small">
          <Button size="small" icon={<PlusOutlined />} onClick={openCreate}>
            {t("situationMonitor.monitors.add", { defaultValue: "Add" })}
          </Button>
        </Space>
      }
    >
      <Typography.Text type="secondary">
        {t("situationMonitor.monitors.hint", {
          defaultValue: "Track keywords across Situation Monitor headlines (case-insensitive).",
        })}
      </Typography.Text>

      <div className="mt-3">
        <Tabs
          items={[
            {
              key: "monitors",
              label: buildTabsLabel(t("situationMonitor.monitors.tab", { defaultValue: "Monitors" }), monitors.length),
              children: (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  <Space wrap>
                    <Button onClick={openCreate} icon={<PlusOutlined />}>
                      {t("situationMonitor.monitors.add", { defaultValue: "Add monitor" })}
                    </Button>
                    <Popconfirm
                      title={t("situationMonitor.monitors.resetConfirm", { defaultValue: "Reset all monitors?" })}
                      onConfirm={() => reset()}
                      okText={t("common.reset", { defaultValue: "Reset" })}
                      cancelText={t("common.cancel", { defaultValue: "Cancel" })}
                    >
                      <Button danger>{t("common.reset", { defaultValue: "Reset" })}</Button>
                    </Popconfirm>
                  </Space>

                  {sortedMonitors.length === 0 ? (
                    <Typography.Text type="secondary">
                      {t("situationMonitor.monitors.empty", { defaultValue: "No monitors yet." })}
                    </Typography.Text>
                  ) : (
                    <List
                      size="small"
                      dataSource={sortedMonitors}
                      renderItem={(monitor) => (
                        <List.Item
                          actions={[
                            <Space key="actions" size="small">
                              <Switch checked={monitor.enabled} onChange={() => toggleMonitor(monitor.id)} />
                              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(monitor)}>
                                {t("common.edit", { defaultValue: "Edit" })}
                              </Button>
                              <Popconfirm
                                title={t("situationMonitor.monitors.deleteConfirm", { defaultValue: "Delete this monitor?" })}
                                okText={t("common.delete", { defaultValue: "Delete" })}
                                cancelText={t("common.cancel", { defaultValue: "Cancel" })}
                                onConfirm={() => deleteMonitor(monitor.id)}
                              >
                                <Button danger size="small" icon={<DeleteOutlined />}>
                                  {t("common.delete", { defaultValue: "Delete" })}
                                </Button>
                              </Popconfirm>
                            </Space>,
                          ]}
                        >
                          <Space direction="vertical" size={6} style={{ width: "100%" }}>
                            <Space size={10} wrap>
                              {monitor.color ? (
                                <span
                                  aria-hidden
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 999,
                                    background: monitor.color,
                                    display: "inline-block",
                                    border: "1px solid rgba(0,0,0,0.15)"
                                  }}
                                />
                              ) : null}
                              <Typography.Text strong>{monitor.name}</Typography.Text>
                              <Tag color={monitor.enabled ? "green" : "default"}>
                                {monitor.enabled
                                  ? t("common.enabled", { defaultValue: "ENABLED" })
                                  : t("common.disabled", { defaultValue: "DISABLED" })}
                              </Tag>
                              <Tag color="geekblue">{matchCounts[monitor.id] ?? 0}</Tag>
                            </Space>
                            <Space size={6} wrap>
                              {monitor.keywords.map((keyword) => (
                                <Tag key={`${monitor.id}-${keyword}`}>{keyword}</Tag>
                              ))}
                            </Space>
                            {monitor.location ? (
                              <Typography.Text type="secondary">
                                <EnvironmentOutlined /> {monitor.location.name} ({monitor.location.lat.toFixed(2)}, {monitor.location.lng.toFixed(2)})
                              </Typography.Text>
                            ) : null}
                          </Space>
                        </List.Item>
                      )}
                    />
                  )}
                </Space>
              ),
            },
            {
              key: "matches",
              label: buildTabsLabel(
                t("situationMonitor.monitors.matchesTab", { defaultValue: "Matches" }),
                matches.length,
                matches.length ? "red" : "default",
              ),
              children: (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  <Space wrap>
                    <Popconfirm
                      title={t("situationMonitor.monitors.clearConfirm", { defaultValue: "Clear matches?" })}
                      onConfirm={() => clearMatches()}
                      okText={t("common.clear", { defaultValue: "Clear" })}
                      cancelText={t("common.cancel", { defaultValue: "Cancel" })}
                    >
                      <Button disabled={matches.length === 0}>{t("common.clear", { defaultValue: "Clear" })}</Button>
                    </Popconfirm>
                  </Space>

                  {sortedMatches.length === 0 ? (
                    <Typography.Text type="secondary">
                      {t("situationMonitor.monitors.noMatches", { defaultValue: "No matches yet." })}
                    </Typography.Text>
                  ) : (
                    <List
                      size="small"
                      pagination={{ pageSize: 12, hideOnSinglePage: true }}
                      dataSource={sortedMatches}
	                      renderItem={(match, idx) => {
	                        const href = match.item.link ? safeHttpUrl(match.item.link) : null;
	                        const date = Number.isFinite(match.item.timestamp) ? new Date(match.item.timestamp) : null;
	                        const itemHref = match.item.itemMetaId ? `/items/${encodeURIComponent(match.item.itemMetaId)}` : null;
	                        const title = translateToZh ? match.item.titleZh ?? match.item.title : match.item.title;
	                        const summary = translateToZh ? match.item.summaryZh ?? match.item.summary : match.item.summary;
	                        return (
	                          <List.Item key={`${match.monitorId}-${idx}`}>
	                            <Space direction="vertical" size={4} style={{ width: "100%" }}>
                              <Space size={8} wrap>
                                <Tag color="geekblue">{match.monitorName}</Tag>
                                {match.item.category ? <Tag>{match.item.category}</Tag> : null}
                                {match.matchedKeywords.map((kw) => (
                                  <Tag
                                    key={`${match.monitorId}-${match.item.link}-${kw}`}
                                    color="blue"
                                    className="cursor-pointer"
                                    onClick={() =>
                                      window.open(`/search?q=${encodeURIComponent(kw)}`, "_blank", "noopener,noreferrer")
                                    }
                                  >
                                    {kw}
                                  </Tag>
                                ))}
                                {itemHref ? (
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={<FileSearchOutlined />}
                                    aria-label={t("situationMonitor.headlines.openItem", { defaultValue: "Open item" })}
                                    onClick={() => window.open(itemHref, "_blank", "noopener,noreferrer")}
                                  />
                                ) : null}
                              </Space>
	                              {href ? (
	                                <Typography.Link href={href} target="_blank" rel="noreferrer">
	                                  {title}
	                                </Typography.Link>
	                              ) : (
	                                <Typography.Text>{title}</Typography.Text>
	                              )}
	                              {summary ? (
	                                <Typography.Paragraph
	                                  type="secondary"
	                                  ellipsis={{ rows: 2 }}
	                                  style={{ marginBottom: 0 }}
	                                >
	                                  {summary}
	                                </Typography.Paragraph>
	                              ) : null}
                              <Space size={10} wrap>
                                <Typography.Text type="secondary">{match.item.source}</Typography.Text>
                                {date ? (
                                  <Typography.Text type="secondary">
                                    {formatDateTime(date, locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                  </Typography.Text>
                                ) : null}
                              </Space>
                            </Space>
                          </List.Item>
                        );
                      }}
                    />
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Modal
        title={
          editingMonitor
            ? t("situationMonitor.monitors.editTitle", { defaultValue: "Edit monitor" })
            : t("situationMonitor.monitors.createTitle", { defaultValue: "Create monitor" })
        }
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => void handleSubmit()}
        okText={editingMonitor ? t("common.save", { defaultValue: "Save" }) : t("common.create", { defaultValue: "Create" })}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ name: "", keywords: [], color: undefined, locationName: undefined, locationLat: undefined, locationLng: undefined }}
          preserve={false}
        >
          <Form.Item
            label={t("situationMonitor.monitors.fields.name", { defaultValue: "Name" })}
            name="name"
            rules={[
              { required: true, message: t("situationMonitor.monitors.validation.name", { defaultValue: "Enter a name." }) },
            ]}
          >
            <Input placeholder={t("situationMonitor.monitors.namePlaceholder", { defaultValue: "e.g. Supply chain disruption" })} />
          </Form.Item>
          <Form.Item
            label={t("situationMonitor.monitors.fields.keywords", { defaultValue: "Keywords" })}
            name="keywords"
            rules={[
              {
                validator: async (_, value: unknown) => {
                  if (!Array.isArray(value) || value.length === 0) {
                    throw new Error(
                      t("situationMonitor.monitors.validation.keywords", { defaultValue: "Add at least one keyword." }),
                    );
                  }
                },
              },
            ]}
          >
            <Select
              mode="tags"
              tokenSeparators={[",", "\n"]}
              placeholder={t("situationMonitor.monitors.keywordsPlaceholder", { defaultValue: "Type keywords and press Enter" })}
              options={[]}
            />
          </Form.Item>
          <Form.Item
            label={t("situationMonitor.monitors.fields.color", { defaultValue: "Color (optional)" })}
            name="color"
            extra={t("situationMonitor.monitors.colorHint", { defaultValue: "Hex color like #1f3b7b. Leave empty for default." })}
          >
            <Input placeholder="#1f3b7b" allowClear />
          </Form.Item>
          <Form.Item
            label={t("situationMonitor.monitors.fields.locationName", { defaultValue: "Location name (optional)" })}
            name="locationName"
            extra={
              <Space size={8} wrap>
                <Button
                  size="small"
                  onClick={() => void resolveLocation()}
                  loading={geocodeLoading}
                  disabled={!session?.accessToken}
                >
                  {t("situationMonitor.monitors.resolveLocation", { defaultValue: "Resolve" })}
                </Button>
                <Typography.Text type="secondary">
                  {t("situationMonitor.monitors.resolveHint", {
                    defaultValue: "Uses cached geocoding to fill Lat/Lng.",
                  })}
                </Typography.Text>
              </Space>
            }
          >
            <Input placeholder={t("situationMonitor.monitors.locationNamePlaceholder", { defaultValue: "e.g. Taipei" })} allowClear />
          </Form.Item>
          <Space size={12} style={{ width: "100%" }}>
            <Form.Item
              label={t("situationMonitor.monitors.fields.lat", { defaultValue: "Lat" })}
              name="locationLat"
              style={{ flex: 1, marginBottom: 0 }}
            >
              <InputNumber style={{ width: "100%" }} placeholder="25.03" min={-90} max={90} step={0.01} />
            </Form.Item>
            <Form.Item
              label={t("situationMonitor.monitors.fields.lng", { defaultValue: "Lng" })}
              name="locationLng"
              style={{ flex: 1, marginBottom: 0 }}
            >
              <InputNumber style={{ width: "100%" }} placeholder="121.56" min={-180} max={180} step={0.01} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
