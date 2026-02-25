const NEWSNOW_PERSONALIZATION_UPDATED_EVENT = "newsnow:personalization-updated";
const NEWSNOW_PERSONALIZATION_CHANNEL = "newsnow-personalization-sync-v1";

export interface NewsnowPersonalizationUpdatedEventDetail {
  updatedAt: number;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function createBroadcastChannel(): BroadcastChannel | null {
  if (!hasWindow() || typeof window.BroadcastChannel === "undefined") {
    return null;
  }
  return new window.BroadcastChannel(NEWSNOW_PERSONALIZATION_CHANNEL);
}

export function emitNewsnowPersonalizationUpdated(
  detail: NewsnowPersonalizationUpdatedEventDetail = { updatedAt: Date.now() },
) {
  if (!hasWindow()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<NewsnowPersonalizationUpdatedEventDetail>(
      NEWSNOW_PERSONALIZATION_UPDATED_EVENT,
      { detail },
    ),
  );

  const channel = createBroadcastChannel();
  if (!channel) {
    return;
  }
  channel.postMessage(detail);
  channel.close();
}

export function subscribeNewsnowPersonalizationUpdated(
  handler: (detail: NewsnowPersonalizationUpdatedEventDetail) => void,
) {
  if (!hasWindow()) {
    return () => undefined;
  }

  const onWindowEvent = (event: Event) => {
    const customEvent = event as CustomEvent<NewsnowPersonalizationUpdatedEventDetail>;
    handler(customEvent.detail ?? { updatedAt: Date.now() });
  };
  window.addEventListener(NEWSNOW_PERSONALIZATION_UPDATED_EVENT, onWindowEvent);

  const channel = createBroadcastChannel();
  if (channel) {
    channel.onmessage = (event: MessageEvent<NewsnowPersonalizationUpdatedEventDetail>) => {
      handler(event.data ?? { updatedAt: Date.now() });
    };
  }

  return () => {
    window.removeEventListener(NEWSNOW_PERSONALIZATION_UPDATED_EVENT, onWindowEvent);
    channel?.close();
  };
}
