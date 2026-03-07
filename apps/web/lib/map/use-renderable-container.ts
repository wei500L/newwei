import { useEffect, useState, type RefObject } from 'react';

import { hasRenderableContainerSize } from './renderable-container';

export { hasRenderableContainerSize, type RenderableContainerLike } from './renderable-container';

export function useRenderableContainer(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }

    const container = ref.current;
    if (!container) {
      setReady(false);
      return;
    }

    const update = () => {
      setReady(hasRenderableContainerSize(container));
    };

    update();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      update();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [enabled, ref]);

  return ready;
}
