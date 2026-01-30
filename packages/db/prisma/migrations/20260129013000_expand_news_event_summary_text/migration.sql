-- Expand NewsEvent + NewsEventTimelineEntry summaries to TEXT to avoid truncation
ALTER TABLE `NewsEvent`
  MODIFY `summary` TEXT NULL;

ALTER TABLE `NewsEventTimelineEntry`
  MODIFY `summary` TEXT NULL;

