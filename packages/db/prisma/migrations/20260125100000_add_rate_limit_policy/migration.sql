-- CreateTable
CREATE TABLE `RateLimitPolicy` (
    `feature` VARCHAR(191) NOT NULL,
    `userLimit` INTEGER NOT NULL,
    `ipLimit` INTEGER NOT NULL,
    `windowSeconds` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `description` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`feature`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RateLimitPolicy` ADD CONSTRAINT `RateLimitPolicy_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
