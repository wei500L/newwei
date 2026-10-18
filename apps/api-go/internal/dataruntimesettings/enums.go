package dataruntimesettings

// Named enums for the closed value sets this unit exposes.

// SettingSource reports where a realtime-signals payload came from.
type SettingSource string

const (
	// SettingSourceEnv is returned when no realtime_signals_settings row exists.
	SettingSourceEnv SettingSource = "env"
	// SettingSourceDB is returned when a realtime_signals_settings row exists.
	SettingSourceDB SettingSource = "db"
)

// ArchiveSettingsSource reports where an archive-preparation payload came from.
type ArchiveSettingsSource string

const (
	// ArchiveSettingsSourceDefault is returned for a falsy stored value.
	ArchiveSettingsSourceDefault ArchiveSettingsSource = "default"
	// ArchiveSettingsSourceDB is returned for a truthy stored value.
	ArchiveSettingsSourceDB ArchiveSettingsSource = "db"
)

// SecretSource reports which layer supplied a credential. It is the NestJS
// RealtimeSignalsSecretSource union.
type SecretSource string

const (
	// SecretSourceStored means the stored configuration supplied the value.
	SecretSourceStored SecretSource = "stored"
	// SecretSourceEnv means the environment default supplied the value.
	SecretSourceEnv SecretSource = "env"
	// SecretSourceNone means nothing is configured.
	SecretSourceNone SecretSource = "none"
)

// AcledAccessTokenStatus is the public ACLED access-token status. Only the
// "missing" value is reachable while ACLED_API_ENABLED is false; the other two
// exist so the response shape matches NestJS exactly.
type AcledAccessTokenStatus string

const (
	// AcledTokenReady means a usable, not-yet-expiring token exists.
	AcledTokenReady AcledAccessTokenStatus = "ready"
	// AcledTokenExpiring means a usable token is inside the refresh window.
	AcledTokenExpiring AcledAccessTokenStatus = "expiring"
	// AcledTokenMissing means no usable token exists.
	AcledTokenMissing AcledAccessTokenStatus = "missing"
	// AcledTokenRefreshFailed means the last refresh attempt failed.
	AcledTokenRefreshFailed AcledAccessTokenStatus = "refresh_failed"
)

// AcledAPIEnabled is the fixed source policy: the current NestJS source has
// ACLED_API_ENABLED = false and the takeover must preserve that policy. No
// access token is reported as usable and no OAuth request is ever made.
const AcledAPIEnabled = false

// AcledAPIDisabledReason is the exact reason string NestJS returns.
const AcledAPIDisabledReason = "Open myACLED does not include API access."

// ArchivePreparationScope is the closed scope set of archive preparation jobs.
type ArchivePreparationScope string

const (
	// ArchiveScopeDigest covers daily digest preparation.
	ArchiveScopeDigest ArchivePreparationScope = "digest"
	// ArchiveScopeCalendar covers monthly calendar preparation.
	ArchiveScopeCalendar ArchivePreparationScope = "calendar"
)

// ArchivePreparationState mirrors the Prisma enum of the same name.
type ArchivePreparationState string

const (
	// ArchiveStateIdle is the "no work recorded" state.
	ArchiveStateIdle ArchivePreparationState = "IDLE"
	// ArchiveStateQueued counts as waiting.
	ArchiveStateQueued ArchivePreparationState = "QUEUED"
	// ArchiveStateProcessing counts as active.
	ArchiveStateProcessing ArchivePreparationState = "PROCESSING"
	// ArchiveStatePartial counts as active.
	ArchiveStatePartial ArchivePreparationState = "PARTIAL"
	// ArchiveStateReady counts as completed.
	ArchiveStateReady ArchivePreparationState = "READY"
	// ArchiveStateFailed counts as failed.
	ArchiveStateFailed ArchivePreparationState = "FAILED"
)
