export type AssistantRunType = 'query' | 'report' | 'forecast';
export type AssistantRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AssistantRunLike {
  type: AssistantRunType;
  status: AssistantRunStatus;
  summary?: string | null;
  error?: string | null;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
}

export interface BuildUserPromptStrings {
  queryFallback: string;
  reportLabel: string;
  forecastLabel: string;
  dailyLabel: string;
  weeklyLabel: string;
  unknownIndicator: string;
  topicLabel: string;
  limitLabel: string;
  lookbackLabel: string;
  modelLabel: string;
}

export interface ResolveAssistantReplyStrings {
  thinking: string;
  queued: string;
  blockedFallback: string;
}

export interface AssistantModelInfo {
  llmModel: string | null;
  forecastModel: string | null;
  modelServiceUsed: boolean | null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export const isTerminalStatus = (status: AssistantRunStatus): boolean => status === 'completed' || status === 'failed';

export function summarizeAssistantError(error: string): string {
  const trimmed = error.trim();
  if (!trimmed) {
    return '';
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('<!doctype') || lower.includes('<html')) {
    const title = trimmed.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1];
    if (title) {
      return title.trim();
    }
    const h1 = trimmed.match(/<h1[^>]*>([^<]{1,200})<\/h1>/i)?.[1];
    if (h1) {
      return h1.trim();
    }
    return 'HTML error response';
  }

  const singleLine = trimmed.replace(/\s+/g, ' ');
  if (singleLine.length > 280) {
    return `${singleLine.slice(0, 280)}…`;
  }
  return singleLine;
}

export function buildUserPromptFromRun(run: AssistantRunLike, strings: BuildUserPromptStrings): string {
  const input = asRecord(run.input);

  if (run.type === 'query') {
    const messageRaw = input?.message;
    if (typeof messageRaw === 'string' && messageRaw.trim().length > 0) {
      return messageRaw.trim();
    }
    return strings.queryFallback;
  }

  if (run.type === 'report') {
    const periodRaw = input?.period;
    const topicRaw = input?.topic;
    const limitRaw = input?.limit;
    const period = periodRaw === 'weekly' ? strings.weeklyLabel : strings.dailyLabel;

    const parts = [`${strings.reportLabel} · ${period}`];
    if (typeof topicRaw === 'string' && topicRaw.trim().length > 0) {
      parts.push(`${strings.topicLabel}: ${topicRaw.trim()}`);
    }
    if (typeof limitRaw === 'number' && Number.isFinite(limitRaw)) {
      parts.push(`${strings.limitLabel}: ${Math.trunc(limitRaw)}`);
    }
    return parts.join(' · ');
  }

  const seriesRaw = input?.series;
  const lookbackRaw = input?.lookbackDays;
  const modelRaw = input?.modelKind;
  const series = typeof seriesRaw === 'string' && seriesRaw.trim().length > 0
    ? seriesRaw.trim()
    : strings.unknownIndicator;

  const details: string[] = [];
  if (typeof lookbackRaw === 'number' && Number.isFinite(lookbackRaw)) {
    details.push(`${strings.lookbackLabel}: ${Math.trunc(lookbackRaw)}`);
  }
  if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
    details.push(`${strings.modelLabel}: ${modelRaw.trim()}`);
  }

  if (details.length === 0) {
    return `${strings.forecastLabel}: ${series}`;
  }

  return `${strings.forecastLabel}: ${series} (${details.join(', ')})`;
}

export function resolveAssistantReply(run: AssistantRunLike, strings: ResolveAssistantReplyStrings): string {
  const output = asRecord(run.output);

  if (output?.blocked === true) {
    const blockedSummary = output.summary;
    if (typeof blockedSummary === 'string' && blockedSummary.trim().length > 0) {
      return blockedSummary.trim();
    }
    if (typeof run.summary === 'string' && run.summary.trim().length > 0) {
      return run.summary.trim();
    }
    return strings.blockedFallback;
  }

  if (typeof run.error === 'string' && run.error.trim().length > 0) {
    const summary = summarizeAssistantError(run.error);
    return summary || run.error.trim();
  }

  if (typeof run.summary === 'string' && run.summary.trim().length > 0) {
    return run.summary.trim();
  }

  if (run.status === 'running') {
    return strings.thinking;
  }

  return strings.queued;
}

export function extractAssistantModelInfo(run: AssistantRunLike): AssistantModelInfo {
  const output = asRecord(run.output);
  const input = asRecord(run.input);
  const raw = asRecord(output?.raw);
  const model = asRecord(output?.model);

  const rawModel =
    typeof raw?.model === 'string' && raw.model.trim().length > 0
      ? raw.model.trim()
      : null;

  const outputModelKind =
    typeof model?.kind === 'string' && model.kind.trim().length > 0
      ? model.kind.trim()
      : typeof output?.modelKind === 'string' && output.modelKind.trim().length > 0
        ? output.modelKind.trim()
        : null;

  const inputModelKind =
    typeof input?.modelKind === 'string' && input.modelKind.trim().length > 0
      ? input.modelKind.trim()
      : null;

  const forecastModel = outputModelKind ?? inputModelKind;

  const modelServiceUsed =
    typeof output?.modelServiceUsed === 'boolean'
      ? output.modelServiceUsed
      : null;

  return {
    llmModel: rawModel,
    forecastModel,
    modelServiceUsed,
  };
}
