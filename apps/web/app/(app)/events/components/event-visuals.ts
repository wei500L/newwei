import type { CSSProperties } from 'react';

export type EventMetricTone = 'heat' | 'credibility';

export interface EventMetricSurface {
  containerStyle: CSSProperties;
  strokeColor: string;
  trailColor: string;
}

export interface EventRowSurfaceOptions {
  heatPercent: number;
  isDark: boolean;
  isFutureEvent: boolean;
}

/**
 * 事件指标小块：surface-inset 同款底色，不要阴影、模糊、渐变。
 * 热度用朱红（--destructive），可信度用墨蓝（--primary），单色进度条。
 * canvas / antd Progress 的 strokeColor 不解析 var()，所以写字面量，值与 globals.css 的 token 一致。
 */
export function resolveEventMetricSurface(
  tone: EventMetricTone,
  isDark: boolean,
): EventMetricSurface {
  const containerStyle: CSSProperties = {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-muted)',
  };
  if (tone === 'heat') {
    return {
      containerStyle,
      strokeColor: isDark ? '#f87171' : '#b91c1c',
      trailColor: isDark ? 'rgba(232, 228, 218, 0.12)' : '#e3dfd6',
    };
  }
  return {
    containerStyle,
    strokeColor: isDark ? '#8fb0ff' : '#1f3b7b',
    trailColor: isDark ? 'rgba(232, 228, 218, 0.12)' : '#e3dfd6',
  };
}

/**
 * 事件行：报纸条目样式——无卡片感，只有底部发丝线；
 * 热度用左侧 3px 色条表达（热度越高越接近朱红），未来事件用琥珀色条。
 */
export function resolveEventRowSurface({
  heatPercent,
  isDark,
  isFutureEvent,
}: EventRowSurfaceOptions): CSSProperties {
  const clampedHeat = Math.max(0, Math.min(heatPercent, 100));
  let barColor: string;
  if (isFutureEvent) {
    barColor = isDark ? '#f59e0b' : '#b45309';
  } else if (clampedHeat >= 70) {
    barColor = isDark ? '#f87171' : '#b91c1c';
  } else if (clampedHeat >= 40) {
    barColor = isDark ? '#9aa3af' : '#5a6270';
  } else {
    barColor = 'var(--border)';
  }
  return {
    borderRadius: 0,
    border: 'none',
    borderBottom: '1px solid var(--border)',
    borderLeft: `3px solid ${barColor}`,
    background: 'transparent',
    padding: '14px 16px',
  };
}

export function resolveFutureEventHintStyle(isDark: boolean): CSSProperties {
  return {
    color: isDark ? '#f59e0b' : '#b45309',
    fontWeight: 600,
  };
}
