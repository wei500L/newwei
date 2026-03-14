import { Injectable } from '@nestjs/common';

import { AkshareFinancialDataProvider } from './akshare.provider';
import { FinancialDataProviderRegistry } from './financial-data-provider';
import { FinnhubFinancialDataProvider } from './finnhub.provider';
import { FredFinancialDataProvider } from './fred.provider';

@Injectable()
export class FinancialDataProviderRegistryInitializer {
  constructor(
    registry: FinancialDataProviderRegistry,
    akshareProvider: AkshareFinancialDataProvider,
    finnhubProvider: FinnhubFinancialDataProvider,
    fredProvider: FredFinancialDataProvider,
  ) {
    registry.register(akshareProvider);
    registry.register(finnhubProvider);
    registry.register(fredProvider);
  }
}
