const UNAUTHORIZED_EVENT = "app:unauthorized";
const FORBIDDEN_EVENT = "app:forbidden";

export interface UnauthorizedEventDetail {
  status?: number;
  reason?: string;
}

export interface ForbiddenEventDetail {
  status?: number;
  reason?: string;
}

export const emitUnauthorized = (detail: UnauthorizedEventDetail = {}) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<UnauthorizedEventDetail>(UNAUTHORIZED_EVENT, { detail }));
};

export const emitForbidden = (detail: ForbiddenEventDetail = {}) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<ForbiddenEventDetail>(FORBIDDEN_EVENT, { detail }));
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

export const onForbidden = (handler: (detail: ForbiddenEventDetail) => void) => {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const listener = (event: Event) => handler((event as CustomEvent<ForbiddenEventDetail>).detail);

  window.addEventListener(FORBIDDEN_EVENT, listener);

  return () => window.removeEventListener(FORBIDDEN_EVENT, listener);
};
