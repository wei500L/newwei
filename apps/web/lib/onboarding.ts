export const ONBOARDING_STEPS = ["today", "events", "map", "finance"] as const;
export const ONBOARDING_TOUR_QUERY_KEY = "tour";
export const ONBOARDING_MODE_QUERY_KEY = "onboarding";
export const ONBOARDING_SETTINGS_PATH = "user-settings/ui/onboarding";

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingUiSettings {
  completed: boolean;
  dismissed: boolean;
  checklist: Record<OnboardingStepKey, boolean>;
  completedTours: Partial<Record<OnboardingStepKey, boolean>>;
}

export interface OnboardingUiSettingsResponse {
  version: number;
  updatedAt?: {
    settings?: string;
  };
  settings: OnboardingUiSettings | null;
}

export function createDefaultOnboardingUiSettings(): OnboardingUiSettings {
  return {
    completed: false,
    dismissed: false,
    checklist: {
      today: false,
      events: false,
      map: false,
      finance: false,
    },
    completedTours: {},
  };
}

export function normalizeOnboardingUiSettings(value: unknown): OnboardingUiSettings {
  const defaults = createDefaultOnboardingUiSettings();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const record = value as Record<string, unknown>;
  const checklist = { ...defaults.checklist };
  const rawChecklist =
    record.checklist && typeof record.checklist === "object" && !Array.isArray(record.checklist)
      ? (record.checklist as Record<string, unknown>)
      : {};

  for (const key of ONBOARDING_STEPS) {
    checklist[key] = rawChecklist[key] === true;
  }

  const completedTours: Partial<Record<OnboardingStepKey, boolean>> = {};
  const rawCompletedTours =
    record.completedTours &&
    typeof record.completedTours === "object" &&
    !Array.isArray(record.completedTours)
      ? (record.completedTours as Record<string, unknown>)
      : {};

  for (const key of ONBOARDING_STEPS) {
    if (rawCompletedTours[key] === true) {
      completedTours[key] = true;
    }
  }

  const allChecklistCompleted = ONBOARDING_STEPS.every((key) => checklist[key]);

  return {
    completed: record.completed === true || allChecklistCompleted,
    dismissed: record.dismissed === true,
    checklist,
    completedTours,
  };
}

export function finalizeOnboardingUiSettings(
  value: OnboardingUiSettings,
): OnboardingUiSettings {
  const normalized = normalizeOnboardingUiSettings(value);
  const allChecklistCompleted = ONBOARDING_STEPS.every(
    (key) => normalized.checklist[key],
  );

  return {
    ...normalized,
    completed: normalized.completed || allChecklistCompleted,
  };
}

export function needsOnboarding(settings: OnboardingUiSettings): boolean {
  return !settings.completed && !settings.dismissed;
}
