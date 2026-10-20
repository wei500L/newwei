package situationsettings

// NewTelegramAuthUpdate builds the update completeAuth applies after a
// successful login. The NestJS controller calls updateSettings with exactly
// these four members (telegramApiId, telegramApiHash, telegramSession and the
// enableTelegram flag), so the credential members take the "present" state of
// the tri-state merge and go through the same encryption policy while every
// other member keeps its current stored value.
func NewTelegramAuthUpdate(apiID, apiHash, session string, enabled bool) UpdateInput {
	return UpdateInput{
		TelegramEnabled: optionalBool{state: presenceValue, value: enabled},
		TelegramAPIID:   optionalString{state: presenceValue, value: apiID},
		TelegramAPIHash: optionalString{state: presenceValue, value: apiHash},
		TelegramSession: optionalString{state: presenceValue, value: session},
	}
}
