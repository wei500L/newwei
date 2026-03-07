import type { CSSProperties } from 'react';

export type EventMetricTone = 'heat' | 'credibility';

export interface EventMetricSurface {
  containerStyle: CSSProperties;
  strokeColor: Record<string, string>;
  trailColor: string;
}

export interface EventRowSurfaceOptions {
  heatPercent: number;
  isDark: boolean;
  isFutureEvent: boolean;
}

const LIGHT_ROW_SHADOW =
  '0 16px 34px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.55)';
const DARK_ROW_SHADOW =
  '0 18px 36px rgba(2, 6, 23, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.04)';

export function resolveEventMetricSurface(
  tone: EventMetricTone,
  isDark: boolean,
): EventMetricSurface {
  const sharedStyle: CSSProperties = {
    padding: '10px 12px',
    borderRadius: 14,
    border: '1px solid transparent',
    boxShadow: isDark
      ? '0 12px 28px rgba(2, 6, 23, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.04)'
      : '0 10px 22px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  };

  if (tone === 'heat') {
    return {
      containerStyle: {
        ...sharedStyle,
        borderColor: isDark ? 'rgba(248, 113, 113, 0.24)' : 'rgba(251, 113, 133, 0.22)',
        background: isDark
          ? 'linear-gradient(180deg, rgba(127, 29, 29, 0.36) 0%, rgba(15, 23, 42, 0.94) 100%)'
          : 'linear-gradient(180deg, rgba(255, 241, 242, 0.96) 0%, rgba(255, 255, 255, 0.98) 100%)',
      },
      strokeColor: isDark
        ? { '0%': '#fda4af', '100%': '#ef4444' }
        : { '0%': '#fda4af', '100%': '#dc2626' },
      trailColor: isDark ? 'rgba(127, 29, 29, 0.34)' : '#ffe4e6',
    };
  }

  return {
    containerStyle: {
      ...sharedStyle,
      borderColor: isDark ? 'rgba(52, 211, 153, 0.26)' : 'rgba(52, 211, 153, 0.22)',
      background: isDark
        ? 'linear-gradient(180deg, rgba(6, 78, 59, 0.34) 0%, rgba(15, 23, 42, 0.94) 100%)'
        : 'linear-gradient(180deg, rgba(236, 253, 245, 0.96) 0%, rgba(255, 255, 255, 0.98) 100%)',
    },
    strokeColor: isDark
      ? { '0%': '#f87171', '50%': '#fbbf24', '100%': '#34d399' }
      : { '0%': '#ef4444', '50%': '#f59e0b', '100%': '#22c55e' },
    trailColor: isDark ? 'rgba(6, 78, 59, 0.3)' : '#ecfdf5',
  };
}

export function resolveEventRowSurface({
  heatPercent,
  isDark,
  isFutureEvent,
}: EventRowSurfaceOptions): CSSProperties {
  const clampedHeat = Math.max(0, Math.min(heatPercent, 100));
  const accentOpacity = Math.max(0.08, Math.min(0.26, (clampedHeat / 100) * 0.26));

  if (isFutureEvent) {
    return isDark
      ? {
          borderRadius: 18,
          border: '1px solid rgba(103, 232, 249, 0.34)',
          background:
            'radial-gradient(circle at top left, rgba(103, 232, 249, 0.18) 0%, transparent 36%), linear-gradient(135deg, rgba(8, 47, 73, 0.92) 0%, rgba(15, 23, 42, 0.96) 52%, rgba(6, 78, 59, 0.88) 100%)',
          boxShadow: DARK_ROW_SHADOW,
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          padding: '18px 20px',
        }
      : {
          borderRadius: 18,
          border: '1px solid rgba(125, 211, 252, 0.75)',
          background:
            'linear-gradient(135deg, rgba(224, 242, 254, 0.96) 0%, rgba(240, 253, 244, 0.94) 100%)',
          boxShadow: LIGHT_ROW_SHADOW,
          padding: '18px 20px',
        };
  }

  return isDark
    ? {
        borderRadius: 18,
        border: `1px solid rgba(100, 116, 139, ${0.48 + accentOpacity / 4})`,
        background: `radial-gradient(circle at top left, rgba(248, 113, 113, ${accentOpacity}) 0%, transparent 34%), linear-gradient(135deg, rgba(15, 23, 42, 0.96) 0%, rgba(17, 24, 39, 0.94) 52%, rgba(30, 41, 59, 0.92) 100%)`,
        boxShadow: DARK_ROW_SHADOW,
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        padding: '18px 20px',
      }
    : {
        borderRadius: 18,
        border: `1px solid rgba(251, 113, 133, ${0.14 + accentOpacity / 3})`,
        background: `linear-gradient(90deg, rgba(255, 241, 242, ${0.74 + accentOpacity / 3}) 0%, rgba(255, 255, 255, 0.98) 34%, rgba(255, 255, 255, 0.98) 100%)`,
        boxShadow: LIGHT_ROW_SHADOW,
        padding: '18px 20px',
      };
}

export function resolveFutureEventHintStyle(isDark: boolean): CSSProperties {
  return {
    color: isDark ? '#67e8f9' : '#0f766e',
    fontWeight: 600,
  };
}
