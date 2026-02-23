interface FenceState {
  marker: '`' | '~';
  length: number;
}

function parseOpeningFence(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(?<fence>`{3,}|~{3,})(?<rest>.*)$/);
  const fence = match?.groups?.fence;
  const rest = match?.groups?.rest ?? '';

  if (!fence) {
    return null;
  }

  const marker = fence[0] as FenceState['marker'];

  // CommonMark: backtick-fenced opener info string cannot contain backticks.
  if (marker === '`' && rest.includes('`')) {
    return null;
  }

  return {
    marker,
    length: fence.length,
  };
}

function isClosingFence(line: string, state: FenceState): boolean {
  const match = line.match(/^ {0,3}(?<fence>`{3,}|~{3,})[ \t]*$/);
  const fence = match?.groups?.fence;
  if (!fence) {
    return false;
  }

  return fence[0] === state.marker && fence.length >= state.length;
}

function resolveUnclosedFence(markdown: string): FenceState | null {
  const lines = markdown.split(/\r?\n/);
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence) {
      if (isClosingFence(line, fence)) {
        fence = null;
      }
      continue;
    }

    fence = parseOpeningFence(line);
  }

  return fence;
}

export function normalizeStreamingMarkdown(markdown: string, isStreaming: boolean): string {
  if (!isStreaming || markdown.length === 0) {
    return markdown;
  }

  const unclosedFence = resolveUnclosedFence(markdown);
  if (!unclosedFence) {
    return markdown;
  }

  const suffix = markdown.endsWith('\n') ? '' : '\n';
  const closingFence = unclosedFence.marker.repeat(unclosedFence.length);
  return `${markdown}${suffix}${closingFence}`;
}
