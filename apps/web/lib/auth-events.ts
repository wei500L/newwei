const UNAUTHORIZED_EVENT = "app:unauthorized";

export interface UnauthorizedEventDetail {
  status?: number;
  reason?: string;
}

export const emitUnauthorized = (detail: UnauthorizedEventDetail = {}) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<UnauthorizedEventDetail>(UNAUTHORIZED_EVENT, { detail }));
};

export const onUnauthorized = (handler: (detail: UnauthorizedEventDetail) => void) => {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const listener = (event: Event) =>
    handler((event as CustomEvent<UnauthorizedEventDetail>).detail);

  window.addEventListener(UNAUTHORIZED_EVENT, listener);

  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
};
