"use client";

import { GlobalOutlined, LineChartOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { extractCountryCodeFromText, getCountryName, normalizeCountryCode } from "@modular/utils";
import { Badge, Card, Col, Modal, Row, Spin, Tag, Timeline, Typography } from "antd";
import type { EChartsOption } from "echarts";
import * as echarts from "echarts/core";
import type { CallbackDataParams } from "echarts/types/dist/shared";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useMetricDrillDownDetailsQuery } from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import dayjs from "@/lib/dayjs";

interface WarMapGeoJsonResponse {
  name: string;
  geoJson: unknown;
}

interface MetricDrillDownProps {
  visible: boolean;
  metricKey: string | null;
  onClose: () => void;
}

export function MetricDrillDown({ visible, metricKey, onClose }: MetricDrillDownProps) {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapName, setMapName] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  
  // Calculate date range for the last 90 days
  const { start, end } = useMemo(() => ({
    start: dayjs.utc().subtract(90, "day").startOf("day").toISOString(),
    end: dayjs.utc().endOf("day").toISOString()
  }), []);

  const { data, loading } = useMetricDrillDownDetailsQuery({
    variables: {
      category: metricKey ?? "",
      start,
      end
    },
    skip: !visible || !metricKey
  });

  const statusColor: Record<string, string> = {
    pending: "processing",
    delivered: "success",
    failed: "error",
    confirmed: "success",
    ignored: "default"
  };

  // Load World Map
  useEffect(() => {
    if (!visible) return;
    if (mapLoaded) return;
    if (!session?.accessToken) return;

    const apiClient = createApiClient({ accessToken: session.accessToken });
    let cancelled = false;
    setMapError(null);

    apiClient
      .get<WarMapGeoJsonResponse>("dashboard/war-map/geojson", {
        params: {
          start,
          end
        }
      })
      .then((response) => {
        if (cancelled) return;
        const name = response.data.name || "world";
        echarts.registerMap(name, response.data.geoJson as any);
        setMapName(name);
        setMapLoaded(true);
      })
      .catch((err) => {
        console.error("Failed to load world map:", err);
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to load map";
          setMapError(message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [end, mapLoaded, session?.accessToken, start, visible]);

  // Process Real Data for Map
  const geoData = useMemo(() => {
    if (!data?.relatedAlerts) return [];
    
    const counts: Record<string, number> = {};
    
    data.relatedAlerts.forEach(alert => {
      let found = false;
      const ctx = alert.context as Record<string, unknown>;
      
      // 1. Try structural context first
      if (ctx?.country || ctx?.countryCode) {
        const code = normalizeCountryCode(
          typeof ctx?.countryCode === "string" ? ctx.countryCode : typeof ctx?.country === "string" ? ctx.country : null
        );
        if (code) {
          const name = getCountryName(code) ?? code;
          counts[name] = (counts[name] || 0) + 1;
          found = true;
        }
      }
      
      // 2. Fallback to text analysis of message
      if (!found && alert.message) {
        const code = extractCountryCodeFromText(alert.message);
        if (code) {
          const name = getCountryName(code) ?? code;
          counts[name] = (counts[name] || 0) + 1;
        }
      }
    });

    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [data]);

  const historyData = useMemo(() => 
    data?.history?.map(point => ({
      date: dayjs(point.timestamp).format('YYYY-MM-DD'),
      value: point.value
    })) ?? [], 
  [data]);

  const trendOption = useMemo<EChartsOption>(() => {
    if (historyData.length === 0) return {};
    return {
      grid: { top: 20, right: 20, bottom: 20, left: 40, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { 
        type: 'category', 
        data: historyData.map(h => h.date),
        boundaryGap: false
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed' } } },
      series: [{
        data: historyData.map(h => h.value),
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.2 },
        lineStyle: { width: 3 },
        itemStyle: { color: '#1890ff' }
      }]
    };
  }, [historyData]);

  const mapOption = useMemo<EChartsOption>(() => {
    if (!mapLoaded || !mapName) return {};
    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: CallbackDataParams | CallbackDataParams[]) => {
          const payload = Array.isArray(params) ? params[0] : params;
          const name = getCountryName(payload?.name) ?? payload?.name ?? "Unknown";
          const value = typeof payload?.value === "number" ? payload.value : 0;
          return `${name}: ${value} Events`;
        }
      },
      visualMap: {
        left: 'right',
        min: 0,
        max: Math.max(5, ...geoData.map(d => d.value)),
        inRange: {
          color: ['#e0ffff', '#006edd']
        },
        text: ['High', 'Low'],
        calculable: true,
        show: geoData.length > 0
      },
      series: [
        {
          name: 'Alert Frequency',
          type: 'map',
          roam: true,
          map: mapName,
          nameProperty: 'name',
          emphasis: {
            label: { show: true },
            itemStyle: { areaColor: '#ffbb00' }
          },
          data: geoData
        }
      ]
    };
  }, [geoData, mapLoaded, mapName]);

  const title = data?.history?.[0]?.item.displayName ?? metricKey;

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <LineChartOutlined className="text-blue-600" />
          <span>{title}</span>
          <Badge status="processing" text={t("dashboard.drilldown.liveAnalysis", "Live Analysis")} className="ml-2" />
        </div>
      }
      open={visible}
      onCancel={onClose}
      width={1200}
      footer={null}
      destroyOnClose
      centered
      className="top-4"
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" />
        </div>
      ) : (
        <>
          <Typography.Paragraph type="secondary" className="mb-6">
             {t("dashboard.drilldown.description", "Detailed analysis and historical trend for {{metric}}", { metric: title })}
          </Typography.Paragraph>

          <Row gutter={[24, 24]}>
            {/* Top Row: Detailed Trend */}
            <Col span={24}>
              <Card size="small" title={t("dashboard.drilldown.historicalTrend", "Historical Trend Analysis")} bordered={false} className="bg-gray-50">
                <DashboardChart option={trendOption} height={250} />
              </Card>
            </Col>

             {/* Bottom Left: Geographic Distribution */}
             <Col xs={24} lg={14}>
              <Card 
                title={<><GlobalOutlined /> {t("dashboard.drilldown.geoImpact", "Geographic Impact")}</>} 
                bordered={false}
                className="h-full border border-gray-100"
              >
                {mapLoaded ? (
                   <DashboardChart option={mapOption} height={400} />
                ) : mapError ? (
                  <div className="h-[400px] flex items-center justify-center bg-gray-50 text-gray-400 text-sm px-6 text-center">
                    {mapError}
                  </div>
                ) : (
                  <div className="h-[400px] flex items-center justify-center bg-gray-50 text-gray-400">
                    <Spin tip="Loading Map Geometry..." />
                  </div>
                )}
                {geoData.length === 0 && mapLoaded && (
                  <div className="text-center text-gray-400 text-xs mt-2">
                    {t("dashboard.drilldown.noGeoData", "No geographic data detected in recent alerts.")}
                  </div>
                )}
              </Card>
            </Col>

            {/* Bottom Right: Context/News Feed */}
            <Col xs={24} lg={10}>
              <Card 
                title={<><UnorderedListOutlined /> {t("dashboard.drilldown.relatedIntelligence", "Related Intelligence")}</>} 
                bordered={false}
                className="h-full border border-gray-100"
                styles={{ body: { maxHeight: 400, overflowY: "auto" } }}
              >
                {data?.relatedAlerts && data.relatedAlerts.length > 0 ? (
                   <Timeline
                    items={data.relatedAlerts.map(event => ({
                      color: event.severity === 'high' ? 'red' : event.severity === 'medium' ? 'orange' : 'green',
                      children: (
                        <div className="pb-2">
                          <div className="flex justify-between items-start">
                            <span className="font-medium text-sm">{event.message}</span>
                            <span className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                              {dayjs(event.triggeredAt).format('MMM D, HH:mm')}
                            </span>
                          </div>
                          <Tag className="mt-1 mr-0" color={statusColor[event.status] ?? "default"}>
                            {event.status.toUpperCase()}
                          </Tag>
                          <span className="text-xs text-gray-500 ml-2">Value: {event.metricValue}</span>
                        </div>
                      )
                    }))}
                  />
                ) : (
                  <div className="text-gray-400 text-center py-8">
                    {t("dashboard.drilldown.noEvents", "No related intelligence events found in the recent period.")}
                  </div>
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </Modal>
  );
}
