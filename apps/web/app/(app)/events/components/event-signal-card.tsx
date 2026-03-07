'use client';

import { Progress, Typography, theme } from 'antd';
import { useMemo } from 'react';

import { useTheme } from '@/hooks/use-theme';

import {
  resolveEventMetricSurface,
  type EventMetricTone,
} from './event-visuals';

export interface EventSignalCardProps {
  label: string;
  value: number | string;
  percent: number;
  tone: EventMetricTone;
  minWidth?: number;
  progressSize?: [number, number];
}

export function EventSignalCard({
  label,
  value,
  percent,
  tone,
  minWidth = 160,
  progressSize = [144, 6],
}: EventSignalCardProps) {
  const { token } = theme.useToken();
  const { isDark } = useTheme();
  const visuals = useMemo(
    () => resolveEventMetricSurface(tone, isDark),
    [isDark, tone],
  );

  return (
    <div style={{ ...visuals.containerStyle, minWidth }}>
      <div className="flex items-center justify-between gap-2">
        <Typography.Text
          strong
          style={{ fontSize: 12, color: token.colorText }}
        >
          {label}
        </Typography.Text>
        <Typography.Text style={{ fontSize: 12, color: token.colorText }}>
          {value}
        </Typography.Text>
      </div>
      <Progress
        percent={Math.min(100, Math.max(0, percent))}
        showInfo={false}
        size={progressSize}
        strokeColor={visuals.strokeColor}
        trailColor={visuals.trailColor}
      />
    </div>
  );
}
