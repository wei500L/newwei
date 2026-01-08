-- AlterEnum
ALTER TABLE `AlertNotificationChannel` MODIFY `type` ENUM('email', 'webhook', 'in_app') NOT NULL;

-- AlterEnum
ALTER TABLE `AlertDelivery` MODIFY `channelType` ENUM('email', 'webhook', 'in_app') NOT NULL;

