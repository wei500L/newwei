-- AlterEnum
ALTER TABLE `AlertRule` MODIFY `metricProvider` ENUM('economic_data', 'system_event', 'pipeline_job', 'crawl_task', 'system_metric', 'economic_anomaly', 'entity_sentiment', 'entity_association', 'realtime_signal') NOT NULL DEFAULT 'economic_data';
