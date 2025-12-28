-- Align SystemSetting with Prisma schema (isPublic flag).
ALTER TABLE `SystemSetting`
  ADD COLUMN `isPublic` BOOLEAN NOT NULL DEFAULT false;
