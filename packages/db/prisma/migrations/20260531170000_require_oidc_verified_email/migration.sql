ALTER TABLE `OrgOidcConfig`
  ADD COLUMN `requireEmailVerified` BOOLEAN NOT NULL DEFAULT true;
