import {
  CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
  DEFAULT_SYSTEM_METRIC_SLUG,
  SYSTEM_METRIC_SLUGS,
} from "@modular/utils";

export {
  CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
  DEFAULT_SYSTEM_METRIC_SLUG,
  SYSTEM_METRIC_SLUGS,
};

export const systemMetricSlugs = SYSTEM_METRIC_SLUGS.map((slug) => ({
  label: slug,
  value: slug,
}));
