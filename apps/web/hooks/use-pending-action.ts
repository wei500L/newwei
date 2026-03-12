import { useCallback, useRef, useState } from 'react';

export interface PendingActionResult<TArgs extends unknown[], TResult> {
  pending: boolean;
  run: (...args: TArgs) => Promise<TResult>;
}

export function usePendingAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult> | TResult,
): PendingActionResult<TArgs, TResult> {
  const [pending, setPending] = useState(false);
  const actionRef = useRef(action);
  const promiseRef = useRef<Promise<TResult> | null>(null);

  actionRef.current = action;

  const run = useCallback((...args: TArgs) => {
    if (promiseRef.current) {
      return promiseRef.current;
    }

    setPending(true);
    const promise = Promise.resolve(actionRef.current(...args)).finally(() => {
      promiseRef.current = null;
      setPending(false);
    });
    promiseRef.current = promise;
    return promise;
  }, []);

  return { pending, run };
}
