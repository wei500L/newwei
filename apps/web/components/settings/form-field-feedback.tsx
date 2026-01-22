import { Form, Typography } from 'antd';
import type { NamePath } from 'antd/es/form/interface';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return Math.ceil(text.length / 4);
  }
  return words.reduce((acc, word) => acc + Math.max(1, Math.ceil(word.length / 4)), 0);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

type Unit = string | undefined;

export function NumberRangeExtra({ name, min, max, unit }: { name: NamePath; min: number; max: number; unit?: Unit }) {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const rawValue = Form.useWatch(name, form);
  const value = toNumber(rawValue);

  const unitLabel = unit ? ` ${unit}` : '';
  const rangeText = t('common.numberRange.range', { min, max, unit: unitLabel });

  if (value === null) {
    return <Typography.Text type="secondary">{rangeText}</Typography.Text>;
  }

  if (value < min) {
    const diff = min - value;
    const details = t('common.numberRange.belowMin', { value, min, diff, unit: unitLabel });
    return (
      <Typography.Text type="danger">
        {rangeText} · {details}
      </Typography.Text>
    );
  }

  if (value > max) {
    const diff = value - max;
    const details = t('common.numberRange.aboveMax', { value, max, diff, unit: unitLabel });
    return (
      <Typography.Text type="danger">
        {rangeText} · {details}
      </Typography.Text>
    );
  }

  const toMin = value - min;
  const toMax = max - value;
  const details = t('common.numberRange.inRange', { value, toMin, toMax, unit: unitLabel });
  return (
    <Typography.Text type="secondary">
      {rangeText} · {details}
    </Typography.Text>
  );
}

export function TokenEstimateExtra({ name }: { name: NamePath }) {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const template = (Form.useWatch(name, form) ?? '') as string;
  const tokens = useMemo(() => estimateTokens(template), [template]);
  return <Typography.Text type="secondary">{t('settings.newsPrompts.estimatedTokens', { count: tokens })}</Typography.Text>;
}

export function TotalTokenEstimateText({
  systemName,
  userName
}: {
  systemName: NamePath;
  userName: NamePath;
}) {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const systemTemplate = (Form.useWatch(systemName, form) ?? '') as string;
  const userTemplate = (Form.useWatch(userName, form) ?? '') as string;
  const totalTokens = useMemo(
    () => estimateTokens(systemTemplate) + estimateTokens(userTemplate),
    [systemTemplate, userTemplate]
  );

  return (
    <Typography.Text type="secondary" style={{ display: 'block', marginBottom: '0.75rem' }}>
      {t('settings.newsPrompts.estimatedTotalTokens', { count: totalTokens })}
    </Typography.Text>
  );
}

