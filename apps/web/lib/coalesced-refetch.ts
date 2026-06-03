export interface CoalescedRefetchScheduler {
  schedule: () => void;
  cancel: () => void;
}

export interface CoalescedRefetchOptions {
  delayMs?: number;
}

const DEFAULT_REFETCH_DELAY_MS = 800;

export function createCoalescedRefetchScheduler(
  refetch: () => Promise<unknown> | unknown,
  options: CoalescedRefetchOptions = {},
): CoalescedRefetchScheduler {
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_REFETCH_DELAY_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pendingAfterFlight = false;
  let cancelled = false;

  const run = () => {
    timer = null;
    if (cancelled) {
      return;
    }
    if (inFlight) {
      pendingAfterFlight = true;
      return;
    }

    inFlight = true;
    Promise.resolve(refetch()).finally(() => {
      inFlight = false;
      if (cancelled || !pendingAfterFlight) {
        pendingAfterFlight = false;
        return;
      }
      pendingAfterFlight = false;
      schedule();
    });
  };

  const schedule = () => {
    if (cancelled) {
      return;
    }
    if (inFlight) {
      pendingAfterFlight = true;
      return;
    }
    if (timer) {
      return;
    }
    timer = setTimeout(run, delayMs);
  };

  const cancel = () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingAfterFlight = false;
  };

  return { schedule, cancel };
}
