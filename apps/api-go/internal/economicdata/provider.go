package economicdata

import "context"

// Provider is the typed boundary implemented by the four upstream adapters.
type Provider interface {
	Kind() ProviderKind
	Configured(ctx context.Context) bool
	Fetch(ctx context.Context, item ItemConfig) (ProviderFetchResult, error)
}

func (s *Service) providerFor(kind ProviderKind) (Provider, error) {
	switch kind {
	case ProviderAkshare:
		return &akshareProvider{service: s}, nil
	case ProviderFinnhub:
		return &finnhubProvider{service: s}, nil
	case ProviderFred:
		return &fredProvider{service: s}, nil
	case ProviderYfinance:
		return &yfinanceProvider{service: s}, nil
	default:
		return nil, &ProviderConfigurationError{Code: "provider_disabled", Message: "provider_disabled"}
	}
}
