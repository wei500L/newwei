import { describe, expect, it } from 'vitest';

import {
  buildUserPromptFromRun,
  extractAssistantModelInfo,
  resolveAssistantReply,
  summarizeAssistantError,
  type BuildUserPromptStrings,
  type ResolveAssistantReplyStrings,
} from '../lib/assistant-chat';

const promptStrings: BuildUserPromptStrings = {
  queryFallback: 'New query',
  reportLabel: 'Report',
  forecastLabel: 'Forecast',
  dailyLabel: 'Daily',
  weeklyLabel: 'Weekly',
  unknownIndicator: 'Unknown indicator',
  topicLabel: 'Topic',
  limitLabel: 'Limit',
  lookbackLabel: 'Lookback',
  modelLabel: 'Model',
};

const replyStrings: ResolveAssistantReplyStrings = {
  thinking: 'Thinking...',
  queued: 'Queued...',
  blockedFallback: 'Blocked by safety checks',
};

describe('summarizeAssistantError', () => {
  it('extracts title from html responses', () => {
    const html = '<!doctype html><html><head><title>Gateway Timeout</title></head><body></body></html>';
    expect(summarizeAssistantError(html)).toBe('Gateway Timeout');
  });
});

describe('resolveAssistantReply', () => {
  it('returns queued text for pending runs without summary/output', () => {
    const text = resolveAssistantReply(
      {
        type: 'query',
        status: 'pending',
        summary: null,
        output: null,
      },
      replyStrings,
    );

    expect(text).toBe('Queued...');
    expect(text.toLowerCase()).not.toContain('null');
  });

  it('returns thinking text for running runs without summary', () => {
    const text = resolveAssistantReply(
      {
        type: 'query',
        status: 'running',
        summary: null,
      },
      replyStrings,
    );

    expect(text).toBe('Thinking...');
  });

  it('prefers blocked summary for blocked output', () => {
    const text = resolveAssistantReply(
      {
        type: 'query',
        status: 'completed',
        output: {
          blocked: true,
          summary: 'Blocked by moderation',
        },
      },
      replyStrings,
    );

    expect(text).toBe('Blocked by moderation');
  });
});

describe('buildUserPromptFromRun', () => {
  it('returns query input message', () => {
    const text = buildUserPromptFromRun(
      {
        type: 'query',
        status: 'completed',
        input: { message: 'How is USD index today?' },
      },
      promptStrings,
    );

    expect(text).toBe('How is USD index today?');
  });

  it('formats report input details', () => {
    const text = buildUserPromptFromRun(
      {
        type: 'report',
        status: 'completed',
        input: {
          period: 'weekly',
          topic: 'new energy',
          limit: 40,
        },
      },
      promptStrings,
    );

    expect(text).toContain('Report · Weekly');
    expect(text).toContain('Topic: new energy');
    expect(text).toContain('Limit: 40');
  });

  it('formats forecast input details', () => {
    const text = buildUserPromptFromRun(
      {
        type: 'forecast',
        status: 'completed',
        input: {
          series: 'usd_index_history',
          lookbackDays: 365,
          modelKind: 'ets',
        },
      },
      promptStrings,
    );

    expect(text).toContain('Forecast: usd_index_history');
    expect(text).toContain('Lookback: 365');
    expect(text).toContain('Model: ets');
  });
});

describe('extractAssistantModelInfo', () => {
  it('reads llm model from output.raw.model', () => {
    const modelInfo = extractAssistantModelInfo({
      type: 'query',
      status: 'completed',
      output: {
        raw: {
          model: 'openai/gpt-4o-mini',
        },
      },
    });

    expect(modelInfo.llmModel).toBe('openai/gpt-4o-mini');
    expect(modelInfo.forecastModel).toBeNull();
    expect(modelInfo.modelServiceUsed).toBeNull();
  });

  it('reads forecast model fields and service flag', () => {
    const modelInfo = extractAssistantModelInfo({
      type: 'forecast',
      status: 'completed',
      input: {
        modelKind: 'ets',
      },
      output: {
        modelServiceUsed: true,
        model: {
          kind: 'arima',
        },
      },
    });

    expect(modelInfo.forecastModel).toBe('arima');
    expect(modelInfo.modelServiceUsed).toBe(true);
  });

  it('falls back to input modelKind when output model kind is absent', () => {
    const modelInfo = extractAssistantModelInfo({
      type: 'forecast',
      status: 'completed',
      input: {
        modelKind: 'ets',
      },
      output: {},
    });

    expect(modelInfo.forecastModel).toBe('ets');
  });
});
