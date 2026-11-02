"use client";

import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { Button, Card, Space, Statistic, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { ECONOMIC_CHANGE_COLORS } from "@/lib/chart-theme-tokens";

const { Title } = Typography;

export interface FinancialCardProps {
  item: {
    id: string;
    title: string; // Ticker or Name
    price?: number;
    change?: number; // Percent
    history?: { timestamp: string; value: number }[];
  };
}

export function FinancialCard({ item }: FinancialCardProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const isPositive = (item.change ?? 0) >= 0;
  const chartColor = isPositive
    ? ECONOMIC_CHANGE_COLORS.positive
    : ECONOMIC_CHANGE_COLORS.negative;
  const openLabel = t("items.detail.openItem");

  const chartOption = item.history
    ? {
        xAxis: {
          type: "category",
          data: item.history.map((h) => h.timestamp),
          show: false,
        },
        yAxis: {
          type: "value",
          min: "dataMin",
          show: false,
        },
        grid: {
          top: 5,
          bottom: 5,
          left: 0,
          right: 0,
        },
        series: [
          {
            data: item.history.map((h) => h.value),
            type: "line",
            smooth: true,
            showSymbol: false,
            lineStyle: {
              width: 2,
              color: chartColor,
            },
            areaStyle: {
              color: chartColor,
              opacity: 0.1,
            },
          },
        ],
        tooltip: {
          trigger: "axis",
          axisPointer: {
            type: "line",
          },
        },
      }
    : null;

  return (
    <Card hoverable className="glass-card" style={{ height: "100%" }}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Title level={5}>{item.title}</Title>
        <Space size="large" align="baseline">
          {item.price !== undefined && (
            <Statistic
              value={item.price}
              precision={2}
              prefix="$"
              valueStyle={{ fontSize: "24px" }}
            />
          )}
          {item.change !== undefined && (
            <Statistic
              value={Math.abs(item.change)}
              precision={2}
              valueStyle={{
                color: isPositive ? "var(--bullish)" : "var(--bearish)",
                fontSize: "16px",
              }}
              prefix={isPositive ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              suffix="%"
            />
          )}
        </Space>
        {chartOption && (
          <div style={{ height: 60 }}>
            <DashboardChart option={chartOption} height={60} />
          </div>
        )}
        <div>
          <Button
            type="link"
            size="small"
            onClick={() => router.push(`/items/${item.id}`)}
            className="px-0"
          >
            {openLabel}
          </Button>
        </div>
      </Space>
    </Card>
  );
}
