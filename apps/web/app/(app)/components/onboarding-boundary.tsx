"use client";

import { Spin } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import {
  ONBOARDING_MODE_QUERY_KEY,
  ONBOARDING_SETTINGS_PATH,
  type OnboardingStepKey,
  type OnboardingUiSettings,
  type OnboardingUiSettingsResponse,
  createDefaultOnboardingUiSettings,
  finalizeOnboardingUiSettings,
  needsOnboarding,
  normalizeOnboardingUiSettings,
} from "@/lib/onboarding";

interface OnboardingContextValue {
  ready: boolean;
  settings: OnboardingUiSettings;
  markChecklistVisited: (step: OnboardingStepKey) => void;
  completeTour: (step: OnboardingStepKey) => void;
  completeOnboarding: () => void;
  dismissOnboarding: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function shouldAllowIncompleteAccess(pathname: string | null, searchParams: URLSearchParams): boolean {
  if (pathname === "/welcome") {
    return true;
  }

  return searchParams.get(ONBOARDING_MODE_QUERY_KEY) === "1";
}

export function OnboardingBoundary({ children }: PropsWithChildren) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<OnboardingUiSettings>(
    createDefaultOnboardingUiSettings(),
  );

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const persistSettings = useCallback(
    async (nextSettings: OnboardingUiSettings) => {
      try {
        await apiClient.put<OnboardingUiSettingsResponse>(ONBOARDING_SETTINGS_PATH, {
          settings: nextSettings,
        });
      } catch (error) {
        captureClientError("Failed to persist onboarding settings", error);
      }
    },
    [apiClient],
  );

  const updateSettings = useCallback(
    (updater: (current: OnboardingUiSettings) => OnboardingUiSettings) => {
      setSettings((current) => {
        const next = finalizeOnboardingUiSettings(updater(current));
        void persistSettings(next);
        return next;
      });
    },
    [persistSettings],
  );

  useEffect(() => {
    if (status !== "authenticated" || !session?.user?.id) {
      setReady(status !== "loading");
      return;
    }

    let cancelled = false;
    setReady(false);

    void apiClient
      .get<OnboardingUiSettingsResponse>(ONBOARDING_SETTINGS_PATH)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setSettings(
          finalizeOnboardingUiSettings(
            normalizeOnboardingUiSettings(response.data?.settings),
          ),
        );
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        captureClientError("Failed to load onboarding settings", error);
        setSettings(createDefaultOnboardingUiSettings());
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, session?.user?.id, status]);

  const allowIncompleteAccess = shouldAllowIncompleteAccess(pathname, searchParams);

  useEffect(() => {
    if (status !== "authenticated" || !ready) {
      return;
    }
    if (needsOnboarding(settings) && !allowIncompleteAccess) {
      router.replace("/welcome");
    }
  }, [allowIncompleteAccess, pathname, ready, router, settings, status]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      ready,
      settings,
      markChecklistVisited: (step) => {
        updateSettings((current) => {
          if (current.checklist[step]) {
            return current;
          }
          return {
            ...current,
            dismissed: false,
            checklist: {
              ...current.checklist,
              [step]: true,
            },
          };
        });
      },
      completeTour: (step) => {
        updateSettings((current) => {
          if (current.completedTours[step]) {
            return current;
          }
          return {
            ...current,
            completedTours: {
              ...current.completedTours,
              [step]: true,
            },
          };
        });
      },
      completeOnboarding: () => {
        updateSettings((current) => ({
          ...current,
          completed: true,
          dismissed: false,
        }));
      },
      dismissOnboarding: () => {
        updateSettings((current) => ({
          ...current,
          dismissed: true,
        }));
      },
    }),
    [ready, settings, updateSettings],
  );

  if (status === "authenticated" && !ready && pathname !== "/welcome") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <Spin size="small" />
          <span>Preparing workspace…</span>
        </div>
      </div>
    );
  }

  if (status === "authenticated" && ready && needsOnboarding(settings) && !allowIncompleteAccess) {
    return null;
  }

  return (
    <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);

  if (!context) {
    throw new Error("useOnboarding must be used inside OnboardingBoundary");
  }

  return context;
}
