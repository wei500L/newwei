"use client";

import { GlobalOutlined, UnorderedListOutlined, LineChartOutlined } from "@ant-design/icons";
import { Badge, Card, Col, Modal, Row, Spin, Tag, Timeline, Typography } from "antd";
import type { EChartsOption } from "echarts";
import * as echarts from "echarts/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

import { DashboardChart } from "@/components/echart";
import { useMetricDrillDownDetailsQuery } from "@/graphql/generated";

interface MetricDrillDownProps {
  visible: boolean;
  metricKey: string | null;
  onClose: () => void;
}

// Simple country name mapping for text analysis
const KNOWN_LOCATIONS = [
  "China", "USA", "United States", "Russia", "Ukraine", "Taiwan", 
  "Japan", "Korea", "Germany", "France", "UK", "United Kingdom",
  "Iran", "Israel", "Gaza", "India", "Brazil"
];

const LOCATION_NORMALIZE: Record<string, string> = {
  "United States": "United States of America",
  "USA": "United States of America",
  "UK": "United Kingdom",
  "Korea": "South Korea"
};

export function MetricDrillDown({ visible, metricKey, onClose }: MetricDrillDownProps) {
  const { t } = useTranslation();
  const [mapLoaded, setMapLoaded] = useState(false);
  
  // Calculate date range for the last 90 days
  const { start, end } = useMemo(() => ({
    start: dayjs().subtract(90, 'day').startOf('day').toISOString(),
    end: dayjs().endOf('day').toISOString()
  }), []);

  const { data, loading } = useMetricDrillDownDetailsQuery({
    variables: {
      category: metricKey ?? "",
      start,
      end
    },
    skip: !visible || !metricKey
  });

  // Load World Map
  useEffect(() => {
    if (mapLoaded) return;
    fetch('https://cdn.jsdelivr.net/npm/@geo-maps/countries-land-10km/map.geo.json')
      .then(response => {
        if (!response.ok) throw new Error('Failed to load map');
        return response.json();
      })
      .then(mapJson => {
        echarts.registerMap('world', mapJson);
        setMapLoaded(true);
      })
      .catch(err => {
        console.error("Failed to load world map:", err);
      });
  }, [mapLoaded]);

  // Process Real Data for Map
  const geoData = useMemo(() => {
    if (!data?.relatedAlerts) return [];
    
    const counts: Record<string, number> = {};
    
    data.relatedAlerts.forEach(alert => {
      let found = false;
      const ctx = alert.context as Record<string, any>;
      
      // 1. Try structural context first
      if (ctx?.country) {
        const name = LOCATION_NORMALIZE[ctx.country] || ctx.country;
        counts[name] = (counts[name] || 0) + 1;
        found = true;
      }
      
      // 2. Fallback to text analysis of message
      if (!found && alert.message) {
        for (const loc of KNOWN_LOCATIONS) {
          if (alert.message.includes(loc)) {
            const name = LOCATION_NORMALIZE[loc] || loc;
            counts[name] = (counts[name] || 0) + 1;
            break; // Count once per alert
          }
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
    if (!mapLoaded) return {};
    return {
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c} Events'
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
          map: 'world',
          emphasis: {
            label: { show: true },
            itemStyle: { areaColor: '#ffbb00' }
          },
          data: geoData
        }
      ]
    };
  }, [mapLoaded, geoData]);

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
                bodyStyle={{ maxHeight: 400, overflowY: 'auto' }}
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
                          <Tag className="mt-1 mr-0" color={event.status === 'pending' ? 'processing' : 'default'}>
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
