import type { Dayjs } from 'dayjs';

import dayjs from '@/lib/dayjs';

export function resolveDefaultSearchTelemetryRange(
  now: Dayjs = dayjs(),
): [Dayjs, Dayjs] {
  const to = now.startOf('day');
  const from = to.subtract(6, 'day');
  return [from, to];
}
