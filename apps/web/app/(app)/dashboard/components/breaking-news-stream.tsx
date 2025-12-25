"use client";

import { ClockCircleOutlined, GlobalOutlined } from "@ant-design/icons";
import { Avatar, Card, List, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

interface NewsItem {
  id: string;
  title: string;
  source: string;
  time: string;
  tag: string;
  priority: 'high' | 'medium' | 'low';
}

const MOCK_NEWS: NewsItem[] = [
  {
    id: '1',
    title: 'Major trade route blockage reported in Suez Canal',
    source: 'Global Trade Wire',
    time: '10 mins ago',
    tag: 'Logistics',
    priority: 'high'
  },
  {
    id: '2',
    title: 'Tech stocks rally amid new AI regulations',
    source: 'Market Watch',
    time: '25 mins ago',
    tag: 'Technology',
    priority: 'medium'
  },
  {
    id: '3',
    title: 'Energy summit concludes with new green initiatives',
    source: 'EcoTimes',
    time: '1 hour ago',
    tag: 'Energy',
    priority: 'low'
  },
  {
    id: '4',
    title: 'Rare earth metal shortage predicted for Q3',
    source: 'Resource Insider',
    time: '2 hours ago',
    tag: 'Resources',
    priority: 'high'
  },
  {
    id: '5',
    title: 'Central Bank announces interest rate decision',
    source: 'Financial Daily',
    time: '3 hours ago',
    tag: 'Finance',
    priority: 'high'
  }
];

export function BreakingNewsStream() {
  const { t } = useTranslation();

  return (
    <Card 
      title={
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
          </span>
          {t("dashboard.news.title", "Breaking News Stream")}
        </div>
      } 
      className="h-full shadow-sm"
      bordered={false}
      bodyStyle={{ padding: '0 12px' }}
    >
      <List
        itemLayout="horizontal"
        dataSource={MOCK_NEWS}
        renderItem={(item) => (
          <List.Item className="hover:bg-gray-50 transition-colors p-3 rounded-lg cursor-pointer my-1">
            <List.Item.Meta
              avatar={
                <Avatar icon={<GlobalOutlined />} style={{ backgroundColor: item.priority === 'high' ? '#ff4d4f' : '#1890ff' }} />
              }
              title={
                <div className="flex justify-between items-start">
                  <Typography.Text strong className="line-clamp-1 mr-2" style={{ fontSize: '14px' }}>
                    {item.title}
                  </Typography.Text>
                  <Tag color={item.priority === 'high' ? 'red' : item.priority === 'medium' ? 'orange' : 'blue'} className="mr-0 text-[10px]">
                    {item.tag}
                  </Tag>
                </div>
              }
              description={
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-gray-500">{item.source}</span>
                  <div className="flex items-center text-xs text-gray-400">
                    <ClockCircleOutlined className="mr-1" />
                    {item.time}
                  </div>
                </div>
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
