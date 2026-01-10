import type { EconomicDataFrequency } from "@prisma/client";
import { EconomicDataValueType } from "@prisma/client";

import type { AkshareDataFieldConfig, AkshareDataItemDefinition } from "./akshare.types";

const REALTIME: EconomicDataFrequency = "realtime";
const HOURLY: EconomicDataFrequency = "hourly";
const DAILY: EconomicDataFrequency = "daily";
const MONTHLY: EconomicDataFrequency = "monthly";
const WEEKLY: EconomicDataFrequency = "weekly";
const CURRENT_YEAR = new Date().getFullYear().toString();

const createOhlcFields = (unit: string): AkshareDataFieldConfig[] => [
  {
    field: "开盘价",
    label: "开盘价",
    unit,
    dataType: EconomicDataValueType.price
  },
  {
    field: "最高价",
    label: "最高价",
    unit,
    dataType: EconomicDataValueType.price
  },
  {
    field: "最低价",
    label: "最低价",
    unit,
    dataType: EconomicDataValueType.price
  },
  {
    field: "收盘价",
    label: "收盘价",
    unit,
    dataType: EconomicDataValueType.price
  }
];

const createEnglishOhlcFields = (
  unit: string,
  dataType: EconomicDataValueType = EconomicDataValueType.price
): AkshareDataFieldConfig[] => [
  {
    field: "open",
    label: "开盘价",
    unit,
    dataType
  },
  {
    field: "high",
    label: "最高价",
    unit,
    dataType
  },
  {
    field: "low",
    label: "最低价",
    unit,
    dataType
  },
  {
    field: "close",
    label: "收盘价",
    unit,
    dataType
  }
];

export const AKSHARE_DATA_DEFINITIONS: AkshareDataItemDefinition[] = [
  {
    id: "gold-futures-realtime",
    slug: "gold_futures_realtime",
    displayName: "黄金期货主力实时行情",
    description: "来自新浪期货的黄金主力合约实时行情",
    categories: ["key-monitor", "military-alert"],
    sourceFunction: "ak.futures_zh_spot",
    endpoint: "/futures_zh_spot",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "AU0",
      market: "CF",
      adjust: "0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      timestampField: "time",
      valueFields: [
        {
          field: "current_price",
          label: "最新价",
          unit: "CNY",
          dataType: EconomicDataValueType.price
        }
      ]
    }
  },
  {
    id: "gold-futures-main",
    slug: "gold_futures_main",
    displayName: "黄金主力合约日线",
    description: "黄金主力连续合约的历史日线行情",
    categories: ["key-monitor", "military-alert", "economic-short", "economic-medium"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "AU0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "silver-futures-realtime",
    slug: "silver_futures_realtime",
    displayName: "白银期货主力实时行情",
    categories: ["key-monitor", "military-alert"],
    sourceFunction: "ak.futures_zh_spot",
    endpoint: "/futures_zh_spot",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "AG0",
      market: "CF",
      adjust: "0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      timestampField: "time",
      valueFields: [
        {
          field: "current_price",
          label: "最新价",
          unit: "CNY",
          dataType: EconomicDataValueType.price
        }
      ]
    }
  },
  {
    id: "crude-oil-futures-main",
    slug: "crude_oil_futures_main",
    displayName: "原油主力合约",
    categories: ["key-monitor", "military-alert"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "SC0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "copper-futures-main",
    slug: "copper_futures_main",
    displayName: "沪铜主力合约",
    categories: ["key-monitor", "military-alert", "economic-medium"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "CU0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "bond-futures-main",
    slug: "gov_bond_futures_main",
    displayName: "国债期货主力合约",
    categories: ["key-monitor"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "T0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "natural-gas-futures-main",
    slug: "natural_gas_futures_main",
    displayName: "天然气主力合约",
    categories: ["key-monitor", "military-alert"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "NG0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("USD")
    }
  },
  {
    id: "rebar-futures-main",
    slug: "rebar_futures_main",
    displayName: "螺纹钢主力合约",
    categories: ["military-alert", "economic-medium"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "RB0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "hotcoil-futures-main",
    slug: "hot_rolled_futures_main",
    displayName: "热轧卷板主力合约",
    categories: ["military-alert", "economic-medium"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "HC0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "aluminum-futures-main",
    slug: "aluminum_futures_main",
    displayName: "沪铝主力合约",
    categories: ["military-alert", "economic-medium"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "AL0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "rubber-futures-main",
    slug: "rubber_futures_main",
    displayName: "橡胶主力合约",
    categories: ["military-alert"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "RU0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "cotton-futures-main",
    slug: "cotton_futures_main",
    displayName: "棉花主力合约",
    categories: ["military-alert", "livelihood-prices"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "CF0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "rice-futures-main",
    slug: "rice_futures_main",
    displayName: "粳稻主力合约",
    categories: ["military-alert", "livelihood-prices"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "RR0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "wheat-futures-main",
    slug: "wheat_futures_main",
    displayName: "强麦主力合约",
    categories: ["military-alert", "livelihood-prices"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "WH0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "corn-futures-main",
    slug: "corn_futures_main",
    displayName: "玉米主力合约",
    categories: ["military-alert", "livelihood-prices"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "C0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "soybean-futures-main",
    slug: "soybean_futures_main",
    displayName: "大豆主力合约",
    categories: ["military-alert", "livelihood-prices"],
    sourceFunction: "ak.futures_main_sina",
    endpoint: "/futures_main_sina",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: {
      symbol: "A0"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: createOhlcFields("CNY")
    }
  },
  {
    id: "platinum-spot-sge",
    slug: "platinum_spot_sge",
    displayName: "铂金现货价格",
    categories: ["military-alert", "key-monitor"],
    sourceFunction: "ak.spot_hist_sge",
    endpoint: "/spot_hist_sge",
    docUrl: "https://akshare.akfamily.xyz/data/spot/spot.html",
    method: "GET",
    defaultParams: {
      symbol: "Pt99.95"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY/克",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "交易日期",
      valueFields: [
        {
          field: "收盘价",
          label: "收盘价",
          unit: "CNY/克",
          dataType: EconomicDataValueType.price
        }
      ]
    }
  },
  {
    id: "palladium-spot-sge",
    slug: "palladium_spot_sge",
    displayName: "钯金现货价格",
    categories: ["military-alert", "key-monitor"],
    sourceFunction: "ak.spot_hist_sge",
    endpoint: "/spot_hist_sge",
    docUrl: "https://akshare.akfamily.xyz/data/spot/spot.html",
    method: "GET",
    defaultParams: {
      symbol: "Pd99.95"
    },
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY/克",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "交易日期",
      valueFields: [
        {
          field: "收盘价",
          label: "收盘价",
          unit: "CNY/克",
          dataType: EconomicDataValueType.price
        }
      ]
    }
  },
  {
    id: "china-treasury-yield-curve",
    slug: "china_treasury_yield_curve",
    displayName: "中国国债收益率曲线",
    categories: ["key-monitor", "economic-alert", "economic-long"],
    sourceFunction: "ak.bond_china_yield",
    endpoint: "/bond_china_yield",
    docUrl: "https://akshare.akfamily.xyz/data/bond/bond.html",
    method: "GET",
    valueType: EconomicDataValueType.yield,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "yieldCurve",
      dateField: "日期",
      seriesFields: [
        { field: "3月", label: "3M", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "6月", label: "6M", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "1年", label: "1Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "3年", label: "3Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "5年", label: "5Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "7年", label: "7Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "10年", label: "10Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "30年", label: "30Y", unit: "%", dataType: EconomicDataValueType.yield }
      ]
    }
  },
  {
    id: "us-treasury-yield-curve",
    slug: "us_treasury_yield_curve",
    displayName: "美国国债收益率曲线",
    categories: ["key-monitor", "economic-alert", "economic-long", "macro-us"],
    sourceFunction: "ak.bond_zh_us_rate",
    endpoint: "/bond_zh_us_rate",
    docUrl: "https://akshare.akfamily.xyz/data/bond/bond.html",
    method: "GET",
    valueType: EconomicDataValueType.yield,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "yieldCurve",
      dateField: "日期",
      seriesFields: [
        { field: "美国国债收益率2年", label: "US 2Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "美国国债收益率5年", label: "US 5Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "美国国债收益率10年", label: "US 10Y", unit: "%", dataType: EconomicDataValueType.yield },
        { field: "美国国债收益率30年", label: "US 30Y", unit: "%", dataType: EconomicDataValueType.yield }
      ]
    }
  },
  {
    id: "shanghai-composite-index",
    slug: "shanghai_composite_index",
    displayName: "上证指数日线",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.stock_zh_index_daily",
    endpoint: "/stock_zh_index_daily",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: {
      symbol: "sh000001"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("pts")
    }
  },
  {
    id: "csi300-index",
    slug: "csi300_index",
    displayName: "沪深300指数日线",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.stock_zh_index_daily",
    endpoint: "/stock_zh_index_daily",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: {
      symbol: "sh000300"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("pts")
    }
  },
  {
    id: "shenzhen-component-index",
    slug: "sz_component_index",
    displayName: "深证成指日线",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.stock_zh_index_daily",
    endpoint: "/stock_zh_index_daily",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: {
      symbol: "sz399001"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("pts")
    }
  },
  {
    id: "csi1000-index",
    slug: "csi1000_index",
    displayName: "中证1000指数日线",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.stock_zh_index_daily",
    endpoint: "/stock_zh_index_daily",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: {
      symbol: "sh000852"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("pts")
    }
  },
  {
    id: "bitcoin-spot-price",
    slug: "bitcoin_spot_price",
    displayName: "比特币实时价格",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.crypto_js_spot",
    endpoint: "/crypto_js_spot",
    docUrl: "https://akshare.akfamily.xyz/data/dc/dc.html",
    method: "GET",
    defaultParams: {},
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      valueFields: [
        {
          field: "latest_price",
          label: "最新价",
          unit: "USD",
          dataType: EconomicDataValueType.price
        }
      ]
    }
  },
  {
    id: "sp500-index",
    slug: "sp500_index",
    displayName: "标普500指数",
    categories: ["key-monitor", "economic-short", "economic-long"],
    sourceFunction: "ak.hf_sp_500",
    endpoint: "/hf_sp_500",
    docUrl: "https://akshare.akfamily.xyz/data/hf/hf.html",
    method: "GET",
    defaultParams: {
      year: CURRENT_YEAR
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("pts")
    }
  },
  {
    id: "china-cpi",
    slug: "china_cpi",
    displayName: "中国CPI月度",
    categories: ["economic-alert", "livelihood-prices", "macro-china"],
    sourceFunction: "ak.macro_china_cpi",
    endpoint: "/macro_china_cpi",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "月份",
      valueFields: [
        {
          field: "全国-当月",
          label: "全国CPI",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "全国-同比增长",
          label: "全国CPI同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "城市-环比增长",
          label: "城市CPI环比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "农村-环比增长",
          label: "农村CPI环比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-gdp",
    slug: "china_gdp",
    displayName: "中国GDP季度",
    categories: ["economic-long", "economic-medium", "macro-china"],
    sourceFunction: "ak.macro_china_gdp",
    endpoint: "/macro_china_gdp",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "亿元",
    defaultFrequency: "monthly" as EconomicDataFrequency,
    parser: {
      type: "macro",
      periodField: "季度",
      valueFields: [
        {
          field: "国内生产总值-绝对值",
          label: "GDP",
          unit: "亿元",
          dataType: EconomicDataValueType.index
        },
        {
          field: "国内生产总值-同比增长",
          label: "GDP同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-money-supply",
    slug: "china_money_supply",
    displayName: "中国M2月度",
    categories: ["economic-medium", "macro-china"],
    sourceFunction: "ak.macro_china_money_supply",
    endpoint: "/macro_china_money_supply",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "亿元",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "月份",
      valueFields: [
        {
          field: "货币和准货币(M2)-数量(亿元)",
          label: "M2",
          unit: "亿元",
          dataType: EconomicDataValueType.index
        },
        {
          field: "货币和准货币(M2)-同比增长",
          label: "M2同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "usd-cny-spot",
    slug: "usd_cny_spot",
    displayName: "美元兑人民币即期汇率",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.fx_quote_baidu",
    endpoint: "/fx_quote_baidu",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: {
      symbol: "美元"
    },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "CNY",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      valueFields: [
        {
          field: "最新价",
          label: "最新价",
          unit: "CNY",
          dataType: EconomicDataValueType.fx
        }
      ]
    }
  },
  {
    id: "eur-cny-spot",
    slug: "eur_cny_spot",
    displayName: "欧元兑人民币即期汇率",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.fx_quote_baidu",
    endpoint: "/fx_quote_baidu",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: {
      symbol: "欧元"
    },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "CNY",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      valueFields: [
        {
          field: "最新价",
          label: "最新价",
          unit: "CNY",
          dataType: EconomicDataValueType.fx
        }
      ]
    }
  },
  {
    id: "china-fx-gold-reserve",
    slug: "china_fx_gold_reserve",
    displayName: "中国黄金与外汇储备",
    categories: ["economic-long", "macro-china"],
    sourceFunction: "ak.macro_china_fx_gold",
    endpoint: "/macro_china_fx_gold",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "月份",
      valueFields: [
        {
          field: "黄金储备-数值",
          label: "黄金储备(万盎司)",
          unit: "万盎司",
          dataType: EconomicDataValueType.quantity
        },
        {
          field: "国家外汇储备-数值",
          label: "外汇储备(亿美元)",
          unit: "亿美元",
          dataType: EconomicDataValueType.index
        }
      ]
    }
  },
  {
    id: "china-ppi",
    slug: "china_ppi",
    displayName: "中国PPI月度",
    categories: ["economic-alert", "livelihood-prices", "macro-china"],
    sourceFunction: "ak.macro_china_ppi_yearly",
    endpoint: "/macro_china_ppi_yearly",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        {
          field: "今值",
          label: "PPI",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-pmi",
    slug: "china_pmi",
    displayName: "中国官方制造业PMI",
    categories: ["economic-alert", "economic-medium", "macro-china"],
    sourceFunction: "ak.macro_china_pmi_yearly",
    endpoint: "/macro_china_pmi_yearly",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        {
          field: "今值",
          label: "PMI",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-rrr",
    slug: "china_reserve_requirement_ratio",
    displayName: "银行存款准备金率",
    categories: ["economic-alert", "macro-china"],
    sourceFunction: "ak.macro_china_reserve_requirement_ratio",
    endpoint: "/macro_china_reserve_requirement_ratio",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: WEEKLY,
    parser: {
      type: "macro",
      periodField: "公布时间",
      valueFields: [
        {
          field: "大型金融机构-调整后",
          label: "大行存准率",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "中小金融机构-调整后",
          label: "中小行存准率",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "us-unemployment-rate",
    slug: "us_unemployment_rate",
    displayName: "美国失业率",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_unemployment_rate",
    endpoint: "/macro_usa_unemployment_rate",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [
        {
          field: "current_value",
          label: "失业率",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "us-services-pmi",
    slug: "us_services_pmi",
    displayName: "美国Markit服务业PMI",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_services_pmi",
    endpoint: "/macro_usa_services_pmi",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "date",
      valueFields: [
        {
          field: "current_value",
          label: "PMI",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-fdi-monthly",
    slug: "china_fdi_monthly",
    displayName: "中国外商直接投资FDI",
    categories: ["economic-medium", "macro-china"],
    sourceFunction: "ak.macro_china_fdi",
    endpoint: "/macro_china_fdi",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "万美元",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "月份",
      valueFields: [
        {
          field: "当月",
          label: "当月FDI",
          unit: "万美元",
          dataType: EconomicDataValueType.index
        },
        {
          field: "当月-同比增长",
          label: "当月同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "当月-环比增长",
          label: "当月环比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "累计",
          label: "累计FDI",
          unit: "万美元",
          dataType: EconomicDataValueType.index
        },
        {
          field: "累计-同比增长",
          label: "累计同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-exports-yoy",
    slug: "china_exports_yoy",
    displayName: "中国出口年率(美元)",
    categories: ["economic-short", "macro-china"],
    sourceFunction: "ak.macro_china_exports_yoy",
    endpoint: "/macro_china_exports_yoy",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        {
          field: "今值",
          label: "出口同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "预测值",
          label: "预测值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "前值",
          label: "前值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-imports-yoy",
    slug: "china_imports_yoy",
    displayName: "中国进口年率(美元)",
    categories: ["economic-short", "macro-china"],
    sourceFunction: "ak.macro_china_imports_yoy",
    endpoint: "/macro_china_imports_yoy",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        {
          field: "今值",
          label: "进口同比",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "预测值",
          label: "预测值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "前值",
          label: "前值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "china-bdti-index",
    slug: "china_bdti_index",
    displayName: "中国BDTI干散货油轮指数",
    categories: ["economic-alert", "macro-china"],
    sourceFunction: "ak.macro_china_bdti_index",
    endpoint: "/macro_china_bdti_index",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "点",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        {
          field: "最新值",
          label: "BDTI指数",
          unit: "点",
          dataType: EconomicDataValueType.index
        },
        {
          field: "涨跌幅",
          label: "日涨跌幅",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "global-shipping-bdi",
    slug: "global_shipping_bdi",
    displayName: "波罗的海干散货指数(BDI)",
    description: "全球干散货运价指标，可用作供应链与地缘冲突扰动的风险代理指标之一",
    categories: ["military-alert", "economic-alert", "macro"],
    sourceFunction: "ak.macro_shipping_bdi",
    endpoint: "/macro_shipping_bdi",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "点",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "最新值", label: "BDI", unit: "点", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3月涨跌幅", label: "近3月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近6月涨跌幅", label: "近6月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近1年涨跌幅", label: "近1年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近2年涨跌幅", label: "近2年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3年涨跌幅", label: "近3年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["shipping", "supply-chain", "geopolitics", "risk"]
  },
  {
    id: "global-shipping-bci",
    slug: "global_shipping_bci",
    displayName: "波罗的海好望角型指数(BCI)",
    description: "全球干散货运价结构指标之一，可用作供应链与地缘冲突扰动的风险代理指标之一",
    categories: ["military-alert", "economic-alert", "macro", "shipping", "geopolitics"],
    sourceFunction: "ak.macro_shipping_bci",
    endpoint: "/macro_shipping_bci",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "点",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "最新值", label: "BCI", unit: "点", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3月涨跌幅", label: "近3月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近6月涨跌幅", label: "近6月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近1年涨跌幅", label: "近1年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近2年涨跌幅", label: "近2年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3年涨跌幅", label: "近3年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["shipping", "supply-chain", "geopolitics", "risk"]
  },
  {
    id: "global-shipping-bpi",
    slug: "global_shipping_bpi",
    displayName: "波罗的海巴拿马型指数(BPI)",
    description: "全球干散货运价结构指标之一，可用作供应链与地缘冲突扰动的风险代理指标之一",
    categories: ["military-alert", "economic-alert", "macro", "shipping", "geopolitics"],
    sourceFunction: "ak.macro_shipping_bpi",
    endpoint: "/macro_shipping_bpi",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "点",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "最新值", label: "BPI", unit: "点", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3月涨跌幅", label: "近3月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近6月涨跌幅", label: "近6月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近1年涨跌幅", label: "近1年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近2年涨跌幅", label: "近2年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3年涨跌幅", label: "近3年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["shipping", "supply-chain", "geopolitics", "risk"]
  },
  {
    id: "global-shipping-bcti",
    slug: "global_shipping_bcti",
    displayName: "波罗的海成品油轮指数(BCTI)",
    description: "油轮运价与能源运输风险代理指标之一，可用作供应链与地缘冲突扰动的风险观测",
    categories: ["military-alert", "economic-alert", "macro", "shipping", "geopolitics"],
    sourceFunction: "ak.macro_shipping_bcti",
    endpoint: "/macro_shipping_bcti",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "点",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "最新值", label: "BCTI", unit: "点", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3月涨跌幅", label: "近3月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近6月涨跌幅", label: "近6月涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近1年涨跌幅", label: "近1年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近2年涨跌幅", label: "近2年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "近3年涨跌幅", label: "近3年涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["shipping", "supply-chain", "geopolitics", "risk"]
  },
  {
    id: "china-epu-index",
    slug: "china_epu_index",
    displayName: "经济政策不确定性指数(EPU)-中国",
    description: "Economic Policy Uncertainty (EPU) 指数（按月），可用于风险偏好/地缘冲突背景下的政策不确定性观测",
    categories: ["military-alert", "economic-alert", "sentiment", "macro-china"],
    sourceFunction: "ak.article_epu_index",
    endpoint: "/article_epu_index",
    docUrl: "https://akshare.akfamily.xyz/data/article/article.html",
    method: "GET",
    defaultParams: {
      symbol: "China"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: MONTHLY,
    parser: {
      type: "yearMonth",
      yearField: "year",
      monthField: "month",
      valueFields: [
        { field: "China_Policy_Index", label: "China EPU", unit: "index", dataType: EconomicDataValueType.index }
      ]
    },
    tags: ["policy", "uncertainty", "geopolitics", "risk"]
  },
  {
    id: "global-epu-index",
    slug: "global_epu_index",
    displayName: "经济政策不确定性指数(EPU)-Global",
    description: "Economic Policy Uncertainty (EPU) 指数（按月），可用于风险偏好/地缘冲突背景下的全球政策不确定性观测",
    categories: ["military-alert", "economic-alert", "sentiment", "macro", "global-conflict-index"],
    sourceFunction: "ak.article_epu_index",
    endpoint: "/article_epu_index",
    docUrl: "https://akshare.akfamily.xyz/data/article/article.html",
    method: "GET",
    defaultParams: {
      symbol: "Global"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: MONTHLY,
    parser: {
      type: "yearMonth",
      yearField: "Year",
      monthField: "Month",
      valueFields: [
        { field: "GEPU_ppp", label: "Global EPU", unit: "index", dataType: EconomicDataValueType.index }
      ]
    },
    tags: ["policy", "uncertainty", "geopolitics", "risk"]
  },
  {
    id: "us-epu-index",
    slug: "us_epu_index",
    displayName: "经济政策不确定性指数(EPU)-美国",
    description: "Economic Policy Uncertainty (EPU) 指数（按月），可用于全球风险偏好与政策不确定性观测",
    categories: ["economic-alert", "sentiment", "macro-us", "geopolitics"],
    sourceFunction: "ak.article_epu_index",
    endpoint: "/article_epu_index",
    docUrl: "https://akshare.akfamily.xyz/data/article/article.html",
    method: "GET",
    defaultParams: {
      symbol: "USA"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: MONTHLY,
    parser: {
      type: "yearMonth",
      yearField: "Year",
      monthField: "Month",
      valueFields: [
        {
          field: "News_Based_Policy_Uncert_Index",
          label: "USA EPU",
          unit: "index",
          dataType: EconomicDataValueType.index
        }
      ]
    },
    tags: ["policy", "uncertainty", "geopolitics", "risk"]
  },
  {
    id: "europe-epu-index",
    slug: "europe_epu_index",
    displayName: "经济政策不确定性指数(EPU)-欧洲",
    description: "Economic Policy Uncertainty (EPU) 指数（按月），可用于全球风险偏好与政策不确定性观测",
    categories: ["economic-alert", "sentiment", "macro", "geopolitics"],
    sourceFunction: "ak.article_epu_index",
    endpoint: "/article_epu_index",
    docUrl: "https://akshare.akfamily.xyz/data/article/article.html",
    method: "GET",
    defaultParams: {
      symbol: "Europe"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: MONTHLY,
    parser: {
      type: "yearMonth",
      yearField: "Year",
      monthField: "Month",
      valueFields: [
        {
          field: "European_News_Index",
          label: "Europe EPU",
          unit: "index",
          dataType: EconomicDataValueType.index
        }
      ]
    },
    tags: ["policy", "uncertainty", "geopolitics", "risk"]
  },
  {
    id: "uk-epu-index",
    slug: "uk_epu_index",
    displayName: "经济政策不确定性指数(EPU)-英国",
    description: "Economic Policy Uncertainty (EPU) 指数（按月），可用于全球风险偏好与政策不确定性观测",
    categories: ["economic-alert", "sentiment", "macro", "geopolitics"],
    sourceFunction: "ak.article_epu_index",
    endpoint: "/article_epu_index",
    docUrl: "https://akshare.akfamily.xyz/data/article/article.html",
    method: "GET",
    defaultParams: {
      symbol: "UK"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: MONTHLY,
    parser: {
      type: "yearMonth",
      yearField: "Year",
      monthField: "Month",
      valueFields: [
        {
          field: "UK_EPU_Index",
          label: "UK EPU",
          unit: "index",
          dataType: EconomicDataValueType.index
        }
      ]
    },
    tags: ["policy", "uncertainty", "geopolitics", "risk"]
  },
  {
    id: "japan-epu-index",
    slug: "japan_epu_index",
    displayName: "经济政策不确定性指数(EPU)-日本",
    description: "Economic Policy Uncertainty (EPU) 指数（按月），可用于全球风险偏好与政策不确定性观测",
    categories: ["economic-alert", "sentiment", "macro", "geopolitics"],
    sourceFunction: "ak.article_epu_index",
    endpoint: "/article_epu_index",
    docUrl: "https://akshare.akfamily.xyz/data/article/article.html",
    method: "GET",
    defaultParams: {
      symbol: "Japan"
    },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: MONTHLY,
    parser: {
      type: "yearMonth",
      yearField: "Year",
      monthField: "Month",
      valueFields: [
        {
          field: "Economic_Policy_Uncertainty_Index",
          label: "Japan EPU",
          unit: "index",
          dataType: EconomicDataValueType.index
        }
      ]
    },
    tags: ["policy", "uncertainty", "geopolitics", "risk"]
  },
  {
    id: "shipping-bdi-latest",
    slug: "shipping_bdi_latest",
    displayName: "供应链压力指标(BDI)",
    description: "波罗的海干散货指数(BDI)最新值（按日），用于 supply-chain-stability 这类综合指标的单一输入",
    categories: ["supply-chain-stability", "macro", "shipping", "geopolitics"],
    sourceFunction: "ak.macro_shipping_bdi",
    endpoint: "/macro_shipping_bdi",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "点",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [{ field: "最新值", label: "BDI", unit: "点", dataType: EconomicDataValueType.index }]
    },
    tags: ["shipping", "supply-chain", "risk"]
  },
  {
    id: "us-core-pce",
    slug: "us_core_pce",
    displayName: "美国核心PCE物价指数",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_core_pce_price",
    endpoint: "/macro_usa_core_pce_price",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [
        {
          field: "current_value",
          label: "当前值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "predicted_value",
          label: "预测值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        },
        {
          field: "previous_value",
          label: "前值",
          unit: "%",
          dataType: EconomicDataValueType.percent
        }
      ]
    }
  },
  {
    id: "us-non-farm-payrolls",
    slug: "us_non_farm_payrolls",
    displayName: "美国非农就业人数",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_non_farm",
    endpoint: "/macro_usa_non_farm",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "万人",
    defaultFrequency: MONTHLY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [
        {
          field: "current_value",
          label: "新增非农",
          unit: "万人",
          dataType: EconomicDataValueType.quantity
        },
        {
          field: "predicted_value",
          label: "预测值",
          unit: "万人",
          dataType: EconomicDataValueType.quantity
        },
        {
          field: "previous_value",
          label: "前值",
          unit: "万人",
          dataType: EconomicDataValueType.quantity
        }
      ]
    }
  },
  {
    id: "us-cpi-monthly",
    slug: "us_cpi_monthly",
    displayName: "美国CPI月率",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_cpi_monthly",
    endpoint: "/macro_usa_cpi_monthly",
    docUrl: "https://github.com/akfamily/akshare/blob/main/docs/data/macro/macro.md",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        { field: "今值", label: "CPI当前值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "预测值", label: "CPI预测值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "前值", label: "CPI前值", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    }
  },
  {
    id: "us-gdp-monthly",
    slug: "us_gdp_monthly",
    displayName: "美国GDP月率",
    categories: ["economic-medium", "macro-us"],
    sourceFunction: "ak.macro_usa_gdp_monthly",
    endpoint: "/macro_usa_gdp_monthly",
    docUrl: "https://github.com/akfamily/akshare/blob/main/docs/data/macro/macro.md",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        { field: "今值", label: "GDP当前值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "预测值", label: "GDP预测值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "前值", label: "GDP前值", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    }
  },
  {
    id: "us-ppi-monthly",
    slug: "us_ppi_monthly",
    displayName: "美国PPI月率",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_ppi",
    endpoint: "/macro_usa_ppi",
    docUrl: "https://github.com/akfamily/akshare/blob/main/docs/data/macro/macro.md",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        { field: "今值", label: "PPI当前值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "预测值", label: "PPI预测值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "前值", label: "PPI前值", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    }
  },
  {
    id: "us-manufacturing-pmi",
    slug: "us_manufacturing_pmi",
    displayName: "美国Markit制造业PMI",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_pmi",
    endpoint: "/macro_usa_pmi",
    docUrl: "https://github.com/akfamily/akshare/blob/main/docs/data/macro/macro.md",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        { field: "今值", label: "PMI当前值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "预测值", label: "PMI预测值", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "前值", label: "PMI前值", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    }
  },
  {
    id: "china-international-tourism-fx",
    slug: "china_international_tourism_fx",
    displayName: "国际旅游外汇收入构成",
    categories: ["livelihood-prices", "macro-china"],
    sourceFunction: "ak.macro_china_international_tourism_fx",
    endpoint: "/macro_china_international_tourism_fx",
    docUrl: "https://github.com/akfamily/akshare/blob/main/docs/data/macro/macro.md",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "百万美元",
    defaultFrequency: MONTHLY,
    parser: {
      type: "macro",
      periodField: "统计年度",
      valueFields: [
        { field: "数量", label: "外汇收入", unit: "百万美元", dataType: EconomicDataValueType.index },
        { field: "比重", label: "收入占比", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    }
  },
  {
    id: "china-fx-mid-rates",
    slug: "china_fx_mid_rates",
    displayName: "人民币中间价(主要货币)",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.currency_boc_safe",
    endpoint: "/currency_boc_safe",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    valueType: EconomicDataValueType.fx,
    defaultUnit: "CNY/100外币",
    defaultFrequency: DAILY,
    parser: {
      type: "macro",
      periodField: "日期",
      valueFields: [
        { field: "美元", label: "美元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "欧元", label: "欧元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "英镑", label: "英镑", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "日元", label: "日元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "港元", label: "港元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "澳元", label: "澳元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "加元", label: "加元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "新加坡元", label: "新加坡元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "瑞士法郎", label: "瑞士法郎", unit: "CNY/100外币", dataType: EconomicDataValueType.fx },
        { field: "新西兰元", label: "新西兰元", unit: "CNY/100外币", dataType: EconomicDataValueType.fx }
      ]
    }
  },
  {
    id: "rmb-fx-cswap-curve",
    slug: "rmb_fx_cswap_curve",
    displayName: "人民币外汇掉期C-Swap曲线",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.fx_c_swap_cm",
    endpoint: "/fx_c_swap_cm",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    valueType: EconomicDataValueType.fx,
    defaultUnit: "Pips",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期时间",
      categoryField: "期限品种",
      valueFields: [
        { field: "掉期点(Pips)", label: "掉期点(Pips)", unit: "Pips", dataType: EconomicDataValueType.fx },
        { field: "全价汇率", label: "全价汇率", unit: "CNY", dataType: EconomicDataValueType.fx }
      ]
    }
  },
  {
    id: "rmb-fx-spot-quotes",
    slug: "rmb_fx_spot_quotes",
    displayName: "人民币外汇即期报价",
    categories: ["key-monitor", "economic-short"],
    sourceFunction: "ak.fx_spot_quote",
    endpoint: "/fx_spot_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    }
  },
  {
    id: "global-fx-pair-quotes",
    slug: "global_fx_pair_quotes",
    displayName: "外币对即期报价",
    categories: ["economic-short"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    valueType: EconomicDataValueType.fx,
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    }
  },
  {
    id: "global-fx-eur-usd-spot",
    slug: "global_fx_eur_usd_spot",
    displayName: "EUR/USD 即期报价",
    categories: ["key-monitor", "economic-alert", "fx", "geopolitics"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: { symbol: "EUR/USD" },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    },
    tags: ["fx", "risk"]
  },
  {
    id: "global-fx-usd-jpy-spot",
    slug: "global_fx_usd_jpy_spot",
    displayName: "USD/JPY 即期报价",
    categories: ["key-monitor", "economic-alert", "fx", "geopolitics"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: { symbol: "USD/JPY" },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    },
    tags: ["fx", "risk"]
  },
  {
    id: "global-fx-usd-chf-spot",
    slug: "global_fx_usd_chf_spot",
    displayName: "USD/CHF 即期报价",
    categories: ["key-monitor", "economic-alert", "fx", "geopolitics"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: { symbol: "USD/CHF" },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    },
    tags: ["fx", "risk"]
  },
  {
    id: "global-fx-gbp-usd-spot",
    slug: "global_fx_gbp_usd_spot",
    displayName: "GBP/USD 即期报价",
    categories: ["key-monitor", "economic-alert", "fx", "geopolitics"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: { symbol: "GBP/USD" },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    },
    tags: ["fx", "risk"]
  },
  {
    id: "global-fx-usd-cad-spot",
    slug: "global_fx_usd_cad_spot",
    displayName: "USD/CAD 即期报价",
    categories: ["key-monitor", "economic-alert", "fx", "geopolitics"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: { symbol: "USD/CAD" },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    },
    tags: ["fx", "risk"]
  },
  {
    id: "global-fx-aud-usd-spot",
    slug: "global_fx_aud_usd_spot",
    displayName: "AUD/USD 即期报价",
    categories: ["key-monitor", "economic-alert", "fx", "geopolitics"],
    sourceFunction: "ak.fx_pair_quote",
    endpoint: "/fx_pair_quote",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: { symbol: "AUD/USD" },
    valueType: EconomicDataValueType.fx,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      categoryField: "货币对",
      valueFields: [
        { field: "买报价", label: "买报价", unit: "", dataType: EconomicDataValueType.fx },
        { field: "卖报价", label: "卖报价", unit: "", dataType: EconomicDataValueType.fx }
      ]
    },
    tags: ["fx", "risk"]
  },
  {
    id: "macro-fx-sentiment",
    slug: "macro_fx_sentiment",
    displayName: "外汇情绪指数",
    description: "金十数据外汇投机情绪(SSI)多空比例指标，高频风险偏好代理，可用于地缘冲击/战争预警的情绪输入之一",
    categories: ["military-alert", "economic-alert", "sentiment", "fx", "geopolitics"],
    sourceFunction: "ak.macro_fx_sentiment",
    endpoint: "/macro_fx_sentiment",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: {
      start_date: "${TODAY_YYYYMMDD-2}",
      end_date: "${TODAY_YYYYMMDD+1}"
    },
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [
        { field: "BTCUSD", label: "BTC/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "ETHUSD", label: "ETH/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "AUDJPY", label: "AUD/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "AUDUSD", label: "AUD/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "XBRUSD", label: "Brent", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "GER40", label: "GER40", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURAUD", label: "EUR/AUD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURGBP", label: "EUR/GBP", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURJPY", label: "EUR/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURUSD", label: "EUR/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "GBPJPY", label: "GBP/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "GBPUSD", label: "GBP/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "NAS100", label: "NAS100", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "NZDUSD", label: "NZD/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "SP500", label: "SP500", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDCAD", label: "USD/CAD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDCHF", label: "USD/CHF", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDJPY", label: "USD/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "XTIUSD", label: "WTI", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "XAGUSD", label: "XAG/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "XAUUSD", label: "XAU/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "US30", label: "US30", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "GBPCHF", label: "GBP/CHF", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURCHF", label: "EUR/CHF", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDX", label: "USDX", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["sentiment", "risk"]
  },
  {
    id: "market-sentiment-usdx",
    slug: "market_sentiment_usdx",
    displayName: "市场情绪(USDX)",
    description: "基于外汇情绪指标中的 USDX 分量，作为市场情绪的一个可观测代理指标",
    categories: ["market-sentiment"],
    sourceFunction: "ak.macro_fx_sentiment",
    endpoint: "/macro_fx_sentiment",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    defaultParams: {
      start_date: "${TODAY_YYYYMMDD-2}",
      end_date: "${TODAY_YYYYMMDD+1}"
    },
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [{ field: "USDX", label: "USDX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["sentiment", "risk"]
  },
  {
    id: "cn-qvix-50etf-min",
    slug: "cn_qvix_50etf_min",
    displayName: "QVIX-50ETF(分钟)",
    description: "50ETF 期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_50etf_min_qvix",
    endpoint: "/index_option_50etf_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-50etf-daily",
    slug: "cn_qvix_50etf_daily",
    displayName: "QVIX-50ETF(日线)",
    description: "50ETF 期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_50etf_qvix",
    endpoint: "/index_option_50etf_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-300etf-min",
    slug: "cn_qvix_300etf_min",
    displayName: "QVIX-300ETF(分钟)",
    description: "300ETF 期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_300etf_min_qvix",
    endpoint: "/index_option_300etf_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-300etf-daily",
    slug: "cn_qvix_300etf_daily",
    displayName: "QVIX-300ETF(日线)",
    description: "300ETF 期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_300etf_qvix",
    endpoint: "/index_option_300etf_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-500etf-min",
    slug: "cn_qvix_500etf_min",
    displayName: "QVIX-500ETF(分钟)",
    description: "500ETF 期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_500etf_min_qvix",
    endpoint: "/index_option_500etf_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-500etf-daily",
    slug: "cn_qvix_500etf_daily",
    displayName: "QVIX-500ETF(日线)",
    description: "500ETF 期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_500etf_qvix",
    endpoint: "/index_option_500etf_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-100etf-min",
    slug: "cn_qvix_100etf_min",
    displayName: "QVIX-100ETF(分钟)",
    description: "100ETF 期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_100etf_min_qvix",
    endpoint: "/index_option_100etf_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-100etf-daily",
    slug: "cn_qvix_100etf_daily",
    displayName: "QVIX-100ETF(日线)",
    description: "100ETF 期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_100etf_qvix",
    endpoint: "/index_option_100etf_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-50index-min",
    slug: "cn_qvix_50index_min",
    displayName: "QVIX-上证50(分钟)",
    description: "上证50期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_50index_min_qvix",
    endpoint: "/index_option_50index_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-50index-daily",
    slug: "cn_qvix_50index_daily",
    displayName: "QVIX-上证50(日线)",
    description: "上证50期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_50index_qvix",
    endpoint: "/index_option_50index_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-300index-min",
    slug: "cn_qvix_300index_min",
    displayName: "QVIX-沪深300(分钟)",
    description: "沪深300期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_300index_min_qvix",
    endpoint: "/index_option_300index_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-300index-daily",
    slug: "cn_qvix_300index_daily",
    displayName: "QVIX-沪深300(日线)",
    description: "沪深300期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_300index_qvix",
    endpoint: "/index_option_300index_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-1000index-min",
    slug: "cn_qvix_1000index_min",
    displayName: "QVIX-中证1000(分钟)",
    description: "中证1000期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_1000index_min_qvix",
    endpoint: "/index_option_1000index_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-1000index-daily",
    slug: "cn_qvix_1000index_daily",
    displayName: "QVIX-中证1000(日线)",
    description: "中证1000期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_1000index_qvix",
    endpoint: "/index_option_1000index_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-cyb-min",
    slug: "cn_qvix_cyb_min",
    displayName: "QVIX-创业板(分钟)",
    description: "创业板期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_cyb_min_qvix",
    endpoint: "/index_option_cyb_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-cyb-daily",
    slug: "cn_qvix_cyb_daily",
    displayName: "QVIX-创业板(日线)",
    description: "创业板期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_cyb_qvix",
    endpoint: "/index_option_cyb_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-kcb-min",
    slug: "cn_qvix_kcb_min",
    displayName: "QVIX-科创板(分钟)",
    description: "科创板期权隐含波动率指数 QVIX(分钟级)，可用于风险偏好/恐慌程度与地缘冲击的高频预警代理指标",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_kcb_min_qvix",
    endpoint: "/index_option_kcb_min_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "time",
      valueFields: [{ field: "qvix", label: "QVIX", unit: "%", dataType: EconomicDataValueType.percent }]
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "cn-qvix-kcb-daily",
    slug: "cn_qvix_kcb_daily",
    displayName: "QVIX-科创板(日线)",
    description: "科创板期权隐含波动率指数 QVIX(日线 OHLC)，用于风险偏好/战争冲击的波动率观测",
    categories: ["military-alert", "economic-alert", "sentiment", "volatility", "geopolitics"],
    sourceFunction: "ak.index_option_kcb_qvix",
    endpoint: "/index_option_kcb_qvix",
    docUrl: "https://akshare.akfamily.xyz/data/option/option.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "%",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: createEnglishOhlcFields("%", EconomicDataValueType.percent)
    },
    tags: ["volatility", "risk", "geopolitics"]
  },
  {
    id: "usd-index-hist",
    slug: "usd_index_history",
    displayName: "美元指数历史行情",
    categories: ["macro", "global-index"],
    sourceFunction: "ak.index_global_hist_em",
    endpoint: "/index_global_hist_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "美元指数" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "今开", label: "开盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最新价", label: "最新价", unit: "", dataType: EconomicDataValueType.index },
        { field: "最高", label: "高", unit: "", dataType: EconomicDataValueType.index },
        { field: "最低", label: "低", unit: "", dataType: EconomicDataValueType.index }
      ]
    }
  },
  {
    id: "comex-gold-inventory",
    slug: "comex_gold_inventory",
    displayName: "COMEX黄金库存",
    categories: ["commodity", "precious-metal"],
    sourceFunction: "ak.futures_comex_inventory",
    endpoint: "/futures_comex_inventory",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "黄金" },
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "吨",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "COMEX黄金库存量-吨", label: "库存(吨)", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "COMEX黄金库存量-盎司", label: "库存(盎司)", unit: "盎司", dataType: EconomicDataValueType.quantity }
      ]
    }
  },
  {
    id: "comex-silver-inventory",
    slug: "comex_silver_inventory",
    displayName: "COMEX白银库存",
    categories: ["commodity", "precious-metal"],
    sourceFunction: "ak.futures_comex_inventory",
    endpoint: "/futures_comex_inventory",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "白银" },
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "吨",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "COMEX白银库存量-吨", label: "库存(吨)", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "COMEX白银库存量-盎司", label: "库存(盎司)", unit: "盎司", dataType: EconomicDataValueType.quantity }
      ]
    }
  },
  {
    id: "spdr-gold-trust-holdings",
    slug: "spdr_gold_trust_holdings",
    displayName: "SPDR Gold Trust 持仓(黄金ETF)",
    description: "全球最大黄金ETF SPDR Gold Trust(GLD)持仓/变动/总价值，用于避险需求与战争风险代理指标",
    categories: ["military-alert", "economic-alert", "commodity", "precious-metal", "geopolitics"],
    sourceFunction: "ak.macro_cons_gold",
    endpoint: "/macro_cons_gold",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "吨",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "总库存", label: "总库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "增持/减持", label: "增持/减持", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "总价值", label: "总价值", unit: "USD", dataType: EconomicDataValueType.price }
      ]
    },
    tags: ["safe-haven", "gold", "risk", "geopolitics"]
  },
  {
    id: "lme-metal-inventory",
    slug: "lme_metal_inventory",
    displayName: "LME金属库存与仓单",
    description: "伦敦金属交易所(LME)库存/注册仓单/注销仓单，可用于供应链与地缘冲突扰动的库存压力观测",
    categories: ["military-alert", "economic-alert", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.macro_euro_lme_stock",
    endpoint: "/macro_euro_lme_stock",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "吨",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "铜-库存", label: "铜-库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铜-注册仓单", label: "铜-注册仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铜-注销仓单", label: "铜-注销仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铝-库存", label: "铝-库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铝-注册仓单", label: "铝-注册仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铝-注销仓单", label: "铝-注销仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "镍-库存", label: "镍-库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "镍-注册仓单", label: "镍-注册仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "镍-注销仓单", label: "镍-注销仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "锌-库存", label: "锌-库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "锌-注册仓单", label: "锌-注册仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "锌-注销仓单", label: "锌-注销仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铅-库存", label: "铅-库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铅-注册仓单", label: "铅-注册仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "铅-注销仓单", label: "铅-注销仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "锡-库存", label: "锡-库存", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "锡-注册仓单", label: "锡-注册仓单", unit: "吨", dataType: EconomicDataValueType.quantity },
        { field: "锡-注销仓单", label: "锡-注销仓单", unit: "吨", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["supply-chain", "inventory", "metals", "risk", "geopolitics"]
  },
  {
    id: "spot-silver-benchmark",
    slug: "spot_silver_benchmark",
    displayName: "上海银基准价",
    categories: ["commodity", "precious-metal"],
    sourceFunction: "ak.spot_silver_benchmark_sge",
    endpoint: "/spot_silver_benchmark_sge",
    docUrl: "https://akshare.akfamily.xyz/data/spot/spot.html",
    method: "GET",
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY/kg",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "交易时间",
      valueFields: [
        { field: "早盘价", label: "早盘价", unit: "CNY/kg", dataType: EconomicDataValueType.price },
        { field: "晚盘价", label: "晚盘价", unit: "CNY/kg", dataType: EconomicDataValueType.price }
      ]
    }
  },
  {
    id: "sp500-index",
    slug: "sp500_index",
    displayName: "标普500指数",
    categories: ["global-index", "macro"],
    sourceFunction: "ak.index_global_hist_em",
    endpoint: "/index_global_hist_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "标普500" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "今开", label: "开盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最新价", label: "收盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最高", label: "高", unit: "", dataType: EconomicDataValueType.index },
        { field: "最低", label: "低", unit: "", dataType: EconomicDataValueType.index }
      ]
    }
  },
  {
    id: "dowjones-index",
    slug: "dowjones_index",
    displayName: "道琼斯指数",
    categories: ["global-index", "macro"],
    sourceFunction: "ak.index_global_hist_em",
    endpoint: "/index_global_hist_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "道琼斯" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "今开", label: "开盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最新价", label: "收盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最高", label: "高", unit: "", dataType: EconomicDataValueType.index },
        { field: "最低", label: "低", unit: "", dataType: EconomicDataValueType.index }
      ]
    }
  },
  {
    id: "nasdaq-index",
    slug: "nasdaq_index",
    displayName: "纳斯达克指数",
    categories: ["global-index", "macro"],
    sourceFunction: "ak.index_global_hist_em",
    endpoint: "/index_global_hist_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "纳斯达克指数" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "今开", label: "开盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最新价", label: "收盘", unit: "", dataType: EconomicDataValueType.index },
        { field: "最高", label: "高", unit: "", dataType: EconomicDataValueType.index },
        { field: "最低", label: "低", unit: "", dataType: EconomicDataValueType.index }
      ]
    }
  },
  {
    id: "crypto-bitcoin-cme",
    slug: "crypto_bitcoin_cme",
    displayName: "CME比特币成交报告",
    categories: ["crypto", "derivatives"],
    sourceFunction: "ak.crypto_bitcoin_cme",
    endpoint: "/crypto_bitcoin_cme",
    docUrl: "https://akshare.akfamily.xyz/data/dc/dc.html",
    method: "GET",
    defaultParams: { date: `${CURRENT_YEAR}0101` },
    valueType: EconomicDataValueType.volume,
    defaultUnit: "contracts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "成交量", label: "成交量", unit: "contracts", dataType: EconomicDataValueType.volume },
        { field: "未平仓合约", label: "未平仓", unit: "contracts", dataType: EconomicDataValueType.volume }
      ]
    }
  },
  {
    id: "crypto-js-spot",
    slug: "crypto_js_spot",
    displayName: "加密货币现货行情",
    categories: ["crypto", "realtime"],
    sourceFunction: "ak.crypto_js_spot",
    endpoint: "/crypto_js_spot",
    docUrl: "https://akshare.akfamily.xyz/data/dc/dc.html",
    method: "GET",
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: REALTIME,
    parser: {
      type: "latest",
      categoryField: "instrument",
      valueFields: [
        { field: "price", label: "最新价", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "vol24h", label: "24h成交量", unit: "USD", dataType: EconomicDataValueType.volume }
      ]
    }
  },
  {
    id: "crypto-btc-kline-daily",
    slug: "crypto_btc_kline_daily",
    displayName: "比特币日线K",
    categories: ["crypto", "timeseries"],
    sourceFunction: "ak.crypto_hist",
    endpoint: "/crypto_hist",
    docUrl: "https://akshare.akfamily.xyz",
    method: "GET",
    defaultParams: { symbol: "BTC", period: "1day" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "timestamp",
      valueFields: createEnglishOhlcFields("USD")
    }
  },
  {
    id: "brent-oil-price",
    slug: "brent_oil_price",
    displayName: "布伦特原油价格",
    categories: ["energy", "commodity"],
    sourceFunction: "ak.futures_uk_brent",
    endpoint: "/futures_uk_brent",
    docUrl: "https://akshare.akfamily.xyz",
    method: "GET",
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [
        { field: "open", label: "开盘", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "high", label: "高", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "low", label: "低", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "close", label: "收盘", unit: "USD", dataType: EconomicDataValueType.price }
      ]
    }
  },
  {
    id: "resource-scarcity-brent",
    slug: "resource_scarcity_brent",
    displayName: "资源紧张(布伦特原油)",
    description: "以布伦特原油收盘价作为资源紧张/能源压力的代理指标之一",
    categories: ["resource-scarcity"],
    sourceFunction: "ak.futures_uk_brent",
    endpoint: "/futures_uk_brent",
    docUrl: "https://akshare.akfamily.xyz",
    method: "GET",
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [{ field: "close", label: "Brent", unit: "USD", dataType: EconomicDataValueType.price }]
    },
    tags: ["energy", "commodity", "risk"]
  },
  {
    id: "global-spx-index-spot",
    slug: "global_spx_index_spot",
    displayName: "标普500指数(现货)",
    description: "全球风险偏好关键代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "SPX" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "SPX", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-ndx-index-spot",
    slug: "global_ndx_index_spot",
    displayName: "纳斯达克指数(现货)",
    description: "全球科技风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "NDX" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "NDX", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-djia-index-spot",
    slug: "global_djia_index_spot",
    displayName: "道琼斯指数(现货)",
    description: "全球风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "DJIA" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "DJIA", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-usd-index-spot",
    slug: "global_usd_index_spot",
    displayName: "美元指数(现货)",
    description: "全球避险/流动性代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "fx", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "UDI" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "index",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "USDX", unit: "index", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "fx", "risk"]
  },
  {
    id: "global-crb-commodity-index-spot",
    slug: "global_crb_commodity_index_spot",
    displayName: "路透CRB商品指数(现货)",
    description: "全球大宗商品景气/通胀压力代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "commodity", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "CRB" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "CRB", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "commodity", "risk"]
  },
  {
    id: "global-bdi-index-spot",
    slug: "global_bdi_index_spot",
    displayName: "波罗的海BDI指数(现货)",
    description: "全球航运/供应链扰动代理指标之一（来自东方财富全球指数现货）",
    categories: ["military-alert", "economic-alert", "shipping", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "BDI" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "BDI", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["shipping", "supply-chain", "risk"]
  },
  {
    id: "global-gdaxi-index-spot",
    slug: "global_gdaxi_index_spot",
    displayName: "德国DAX指数(现货)",
    description: "欧洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "GDAXI" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "DAX", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-ftse100-index-spot",
    slug: "global_ftse100_index_spot",
    displayName: "英国富时100指数(现货)",
    description: "欧洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "FTSE" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "FTSE100", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-cac40-index-spot",
    slug: "global_cac40_index_spot",
    displayName: "法国CAC40指数(现货)",
    description: "欧洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "FCHI" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "CAC40", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-eurostoxx50-index-spot",
    slug: "global_eurostoxx50_index_spot",
    displayName: "欧洲斯托克50指数(现货)",
    description: "欧洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "SX5E" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "STOXX50", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-nikkei225-index-spot",
    slug: "global_nikkei225_index_spot",
    displayName: "日经225指数(现货)",
    description: "亚洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "N225" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "Nikkei225", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-hsi-index-spot",
    slug: "global_hsi_index_spot",
    displayName: "恒生指数(现货)",
    description: "亚洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "HSI" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "HSI", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-kospi-index-spot",
    slug: "global_kospi_index_spot",
    displayName: "韩国KOSPI指数(现货)",
    description: "亚洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "KS11" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "KOSPI", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-smi-index-spot",
    slug: "global_smi_index_spot",
    displayName: "瑞士SMI指数(现货)",
    description: "欧洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "SSMI" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "SMI", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-rts-index-spot",
    slug: "global_rts_index_spot",
    displayName: "俄罗斯RTS指数(现货)",
    description: "地缘冲突敏感市场代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "RTS" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "RTS", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "geopolitics", "risk"]
  },
  {
    id: "global-bovespa-index-spot",
    slug: "global_bovespa_index_spot",
    displayName: "巴西BOVESPA指数(现货)",
    description: "新兴市场风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "BVSP" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "BVSP", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-sensex-index-spot",
    slug: "global_sensex_index_spot",
    displayName: "印度SENSEX指数(现货)",
    description: "新兴市场风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "SENSEX" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "SENSEX", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-ibex35-index-spot",
    slug: "global_ibex35_index_spot",
    displayName: "西班牙IBEX35指数(现货)",
    description: "欧洲风险偏好代理指标之一（来自东方财富全球指数现货）",
    categories: ["key-monitor", "economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.index_global_spot_em",
    endpoint: "/index_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/index/index.html",
    method: "GET",
    defaultParams: { symbol: "IBEX" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      timestampField: "最新行情时间",
      valueFields: [
        { field: "最新价", label: "IBEX35", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-sox-index",
    slug: "global_sox_index",
    displayName: "全球半导体指数(SOX)",
    description: "半导体景气与风险偏好代理指标之一（按日）",
    categories: ["economic-alert", "global-index", "geopolitics"],
    sourceFunction: "ak.macro_global_sox_index",
    endpoint: "/macro_global_sox_index",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "最新值", label: "SOX", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-wti-crude-spot",
    slug: "global_wti_crude_spot",
    displayName: "WTI原油(全球连续合约现货)",
    description: "能源供应冲击与冲突外溢风险的关键代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "energy", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "CL00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "WTI", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "commodity", "risk"]
  },
  {
    id: "global-henry-hub-natural-gas-spot",
    slug: "global_henry_hub_natural_gas_spot",
    displayName: "天然气(全球连续合约现货)",
    description: "能源供需与地缘冲突扰动的代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "energy", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "NG00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "NG", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "commodity", "risk"]
  },
  {
    id: "global-comex-gold-spot",
    slug: "global_comex_gold_spot",
    displayName: "COMEX黄金(全球连续合约现货)",
    description: "避险资产代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "commodity", "precious-metal", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "GC00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Gold", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["safe-haven", "risk"]
  },
  {
    id: "global-comex-silver-spot",
    slug: "global_comex_silver_spot",
    displayName: "COMEX白银(全球连续合约现货)",
    description: "避险/工业金属双属性代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "commodity", "precious-metal", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "SI00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Silver", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["safe-haven", "risk"]
  },
  {
    id: "global-comex-copper-spot",
    slug: "global_comex_copper_spot",
    displayName: "COMEX铜(全球连续合约现货)",
    description: "工业活动/供应链扰动代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "HG00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Copper", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["industrial", "supply-chain", "risk"]
  },
  {
    id: "global-emini-sp500-spot",
    slug: "global_emini_sp500_spot",
    displayName: "E-mini标普500(全球连续合约现货)",
    description: "全球风险偏好关键代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "derivatives", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "ES00Y" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "ES", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-emini-nasdaq-spot",
    slug: "global_emini_nasdaq_spot",
    displayName: "E-mini纳斯达克(全球连续合约现货)",
    description: "全球科技风险偏好代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "derivatives", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "NQ00Y" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "NQ", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-mini-dow-spot",
    slug: "global_mini_dow_spot",
    displayName: "Mini道琼斯(全球连续合约现货)",
    description: "全球风险偏好代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "derivatives", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "YM00Y" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "YM", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-us-treasury-2y-futures",
    slug: "global_us_treasury_2y_futures_spot",
    displayName: "美国2年期国债期货(连续)",
    description: "利率预期与避险情绪的代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "macro-us", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "TU00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "price",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "US 2Y", unit: "price", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["rates", "risk"]
  },
  {
    id: "global-us-treasury-5y-futures",
    slug: "global_us_treasury_5y_futures_spot",
    displayName: "美国5年期国债期货(连续)",
    description: "利率预期与避险情绪的代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "macro-us", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "FV00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "price",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "US 5Y", unit: "price", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["rates", "risk"]
  },
  {
    id: "global-us-treasury-10y-futures",
    slug: "global_us_treasury_10y_futures_spot",
    displayName: "美国10年期国债期货(连续)",
    description: "利率预期与避险情绪的代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "macro-us", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "TY00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "price",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "US 10Y", unit: "price", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["rates", "risk"]
  },
  {
    id: "global-us-treasury-30y-futures",
    slug: "global_us_treasury_30y_futures_spot",
    displayName: "美国30年期国债期货(连续)",
    description: "利率预期与避险情绪的代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "macro-us", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "US00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "price",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "US 30Y", unit: "price", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["rates", "risk"]
  },
  {
    id: "global-cn-a50-futures-spot",
    slug: "global_cn_a50_futures_spot",
    displayName: "A50期指(连续)",
    description: "亚太风险偏好代理指标之一（来自东方财富全球期货现货）",
    categories: ["key-monitor", "economic-alert", "derivatives", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "CN00Y" },
    valueType: EconomicDataValueType.index,
    defaultUnit: "pts",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "A50", unit: "pts", dataType: EconomicDataValueType.index },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["global", "equity", "risk"]
  },
  {
    id: "global-nymex-gasoline-spot",
    slug: "global_nymex_gasoline_spot",
    displayName: "NYMEX汽油(连续)",
    description: "成品油价格与能源供给扰动代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "energy", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "RB00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Gasoline", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "commodity", "risk"]
  },
  {
    id: "global-nymex-heating-oil-spot",
    slug: "global_nymex_heating_oil_spot",
    displayName: "NYMEX燃油(连续)",
    description: "成品油价格与能源供给扰动代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "key-monitor", "energy", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "HO00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "USD",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "HeatingOil", unit: "USD", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "成交量", label: "成交量", unit: "", dataType: EconomicDataValueType.volume },
        { field: "持仓量", label: "持仓量", unit: "", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "commodity", "risk"]
  },
  {
    id: "global-wheat-spot",
    slug: "global_wheat_spot",
    displayName: "小麦(全球连续合约现货)",
    description: "粮食价格/地缘冲突外溢风险代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "livelihood-prices", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "ZW00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Wheat", unit: "", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["food", "risk"]
  },
  {
    id: "global-corn-spot",
    slug: "global_corn_spot",
    displayName: "玉米(全球连续合约现货)",
    description: "粮食价格/地缘冲突外溢风险代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "livelihood-prices", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "ZC00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Corn", unit: "", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["food", "risk"]
  },
  {
    id: "global-soybean-spot",
    slug: "global_soybean_spot",
    displayName: "大豆(全球连续合约现货)",
    description: "粮食价格/地缘冲突外溢风险代理指标之一（来自东方财富全球期货现货）",
    categories: ["military-alert", "livelihood-prices", "commodity", "geopolitics"],
    sourceFunction: "ak.futures_global_spot_em",
    endpoint: "/futures_global_spot_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "ZS00Y" },
    valueType: EconomicDataValueType.price,
    defaultUnit: "",
    defaultFrequency: HOURLY,
    parser: {
      type: "latest",
      valueFields: [
        { field: "最新价", label: "Soybeans", unit: "", dataType: EconomicDataValueType.price },
        { field: "涨跌幅", label: "涨跌幅", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    },
    tags: ["food", "risk"]
  },
  {
    id: "opec-crude-production",
    slug: "opec_crude_production",
    displayName: "OPEC原油产量(按月)",
    description: "OPEC 成员国产量（按月），用于能源供给侧与地缘冲突风险的观测",
    categories: ["military-alert", "economic-alert", "energy", "geopolitics"],
    sourceFunction: "ak.macro_cons_opec_month",
    endpoint: "/macro_cons_opec_month",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "万桶/日",
    defaultFrequency: MONTHLY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "欧佩克产量", label: "OPEC总产量", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "沙特", label: "沙特", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "伊朗", label: "伊朗", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "伊拉克", label: "伊拉克", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "阿联酋", label: "阿联酋", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "科威特", label: "科威特", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "利比亚", label: "利比亚", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "尼日利亚", label: "尼日利亚", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "委内瑞拉", label: "委内瑞拉", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "阿尔及利亚", label: "阿尔及利亚", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "安哥拉", label: "安哥拉", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "加蓬", label: "加蓬", unit: "万桶/日", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "supply", "geopolitics", "risk"]
  },
  {
    id: "us-api-crude-stock",
    slug: "us_api_crude_stock",
    displayName: "美国API原油库存(周)",
    description: "API 周度原油库存变动/预测/前值，用于能源供给与突发冲击风险观测",
    categories: ["military-alert", "economic-alert", "energy", "macro-us", "geopolitics"],
    sourceFunction: "ak.macro_usa_api_crude_stock",
    endpoint: "/macro_usa_api_crude_stock",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "万桶",
    defaultFrequency: WEEKLY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "今值", label: "今值", unit: "万桶", dataType: EconomicDataValueType.quantity },
        { field: "预测值", label: "预测值", unit: "万桶", dataType: EconomicDataValueType.quantity },
        { field: "前值", label: "前值", unit: "万桶", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "inventory", "geopolitics", "risk"]
  },
  {
    id: "us-crude-production",
    slug: "us_crude_production",
    displayName: "美国原油产量(周)",
    description: "美国国内原油产量（总量/本土48州/阿拉斯加）与变化，用于能源供给侧与地缘冲突风险观测",
    categories: ["military-alert", "economic-alert", "energy", "macro-us", "geopolitics"],
    sourceFunction: "ak.macro_usa_crude_inner",
    endpoint: "/macro_usa_crude_inner",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "万桶/日",
    defaultFrequency: WEEKLY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "美国国内原油总量-产量", label: "总产量", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "美国国内原油总量-变化", label: "总量变化", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "美国本土48州原油产量-产量", label: "本土48州产量", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "美国本土48州原油产量-变化", label: "本土48州变化", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "美国阿拉斯加州原油产量-产量", label: "阿拉斯加产量", unit: "万桶/日", dataType: EconomicDataValueType.quantity },
        { field: "美国阿拉斯加州原油产量-变化", label: "阿拉斯加变化", unit: "万桶/日", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "supply", "geopolitics", "risk"]
  },
  {
    id: "us-rig-count",
    slug: "us_rig_count",
    displayName: "美国钻井数量(周)",
    description: "贝克休斯钻井数据（总数/石油/天然气/混合）与变化，用于能源供给侧与地缘冲突风险观测",
    categories: ["military-alert", "economic-alert", "energy", "macro-us", "geopolitics"],
    sourceFunction: "ak.macro_usa_rig_count",
    endpoint: "/macro_usa_rig_count",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultUnit: "座",
    defaultFrequency: WEEKLY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "钻井总数_钻井数", label: "钻井总数", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "钻井总数_变化", label: "总数变化", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "美国石油钻井_钻井数", label: "石油钻井", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "美国石油钻井_变化", label: "石油变化", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "美国天然气钻井_钻井数", label: "天然气钻井", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "美国天然气钻井_变化", label: "天然气变化", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "混合钻井_钻井数", label: "混合钻井", unit: "座", dataType: EconomicDataValueType.quantity },
        { field: "混合钻井_变化", label: "混合变化", unit: "座", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["energy", "supply", "geopolitics", "risk"]
  },
  {
    id: "cn-futures-inventory-fu",
    slug: "cn_futures_inventory_fu",
    displayName: "燃料油期货库存(国内)",
    description: "国内燃料油库存数据（东财），可用于能源供给扰动与地缘冲击监测",
    categories: ["military-alert", "economic-alert", "energy", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "fu" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "energy", "risk", "geopolitics"]
  },
  {
    id: "cn-futures-inventory-au",
    slug: "cn_futures_inventory_au",
    displayName: "黄金期货库存(国内)",
    description: "国内黄金库存数据（东财），可用于避险需求与战争风险的库存侧观测",
    categories: ["military-alert", "economic-alert", "commodity", "precious-metal", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "au" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "safe-haven", "gold", "risk"]
  },
  {
    id: "cn-futures-inventory-ag",
    slug: "cn_futures_inventory_ag",
    displayName: "白银期货库存(国内)",
    description: "国内白银库存数据（东财），可用于避险需求与战争风险的库存侧观测",
    categories: ["military-alert", "economic-alert", "commodity", "precious-metal", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "ag" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "safe-haven", "silver", "risk"]
  },
  {
    id: "cn-futures-inventory-cu",
    slug: "cn_futures_inventory_cu",
    displayName: "铜期货库存(国内)",
    description: "国内铜库存数据（东财），可用于供应链压力与地缘冲突扰动观测",
    categories: ["military-alert", "economic-alert", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "cu" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "metals", "supply-chain", "risk"]
  },
  {
    id: "cn-futures-inventory-al",
    slug: "cn_futures_inventory_al",
    displayName: "铝期货库存(国内)",
    description: "国内铝库存数据（东财），可用于供应链压力与地缘冲突扰动观测",
    categories: ["military-alert", "economic-alert", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "al" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "metals", "supply-chain", "risk"]
  },
  {
    id: "cn-futures-inventory-ni",
    slug: "cn_futures_inventory_ni",
    displayName: "镍期货库存(国内)",
    description: "国内镍库存数据（东财），可用于关键金属供应链与地缘冲突扰动观测",
    categories: ["military-alert", "economic-alert", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "ni" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "metals", "supply-chain", "risk"]
  },
  {
    id: "cn-futures-inventory-iron-ore",
    slug: "cn_futures_inventory_iron_ore",
    displayName: "铁矿石期货库存(国内)",
    description: "国内铁矿石库存数据（东财），可用于大宗与供应链压力观测",
    categories: ["military-alert", "economic-alert", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "i" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "metals", "supply-chain", "risk"]
  },
  {
    id: "cn-futures-inventory-rebar",
    slug: "cn_futures_inventory_rebar",
    displayName: "螺纹钢期货库存(国内)",
    description: "国内螺纹钢库存数据（东财），可用于工业需求与供应链压力观测",
    categories: ["military-alert", "economic-alert", "commodity", "inventory", "geopolitics"],
    sourceFunction: "ak.futures_inventory_em",
    endpoint: "/futures_inventory_em",
    docUrl: "https://akshare.akfamily.xyz/data/futures/futures.html",
    method: "GET",
    defaultParams: { symbol: "rb" },
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [
        { field: "库存", label: "库存", dataType: EconomicDataValueType.quantity },
        { field: "增减", label: "增减", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["inventory", "metals", "supply-chain", "risk"]
  },
  {
    id: "cn-spot-corn",
    slug: "cn_spot_corn_price",
    displayName: "玉米现货价格(国内)",
    description: "国内玉米现货价格（搜猪网），可用于粮食价格与冲突外溢风险观测",
    categories: ["military-alert", "livelihood-prices", "commodity", "geopolitics"],
    sourceFunction: "ak.spot_corn_price_soozhu",
    endpoint: "/spot_corn_price_soozhu",
    docUrl: "https://akshare.akfamily.xyz/data/spot/spot.html",
    method: "GET",
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY/kg",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [{ field: "价格", label: "价格", unit: "CNY/kg", dataType: EconomicDataValueType.price }]
    },
    tags: ["food", "risk"]
  },
  {
    id: "cn-spot-soybean",
    slug: "cn_spot_soybean_price",
    displayName: "大豆现货价格(国内)",
    description: "国内大豆现货价格（搜猪网），可用于粮食价格与冲突外溢风险观测",
    categories: ["military-alert", "livelihood-prices", "commodity", "geopolitics"],
    sourceFunction: "ak.spot_soybean_price_soozhu",
    endpoint: "/spot_soybean_price_soozhu",
    docUrl: "https://akshare.akfamily.xyz/data/spot/spot.html",
    method: "GET",
    valueType: EconomicDataValueType.price,
    defaultUnit: "CNY/kg",
    defaultFrequency: DAILY,
    parser: {
      type: "timeseries",
      timestampField: "日期",
      valueFields: [{ field: "价格", label: "价格", unit: "CNY/kg", dataType: EconomicDataValueType.price }]
    },
    tags: ["food", "risk"]
  },
  {
    id: "china-fx-gold-reserves",
    slug: "china_fx_gold_reserves",
    displayName: "中国外汇储备与黄金储备",
    description: "中国外汇储备与黄金储备（按月/按年混合），可用于制裁/资本流动与地缘风险的结构性观测",
    categories: ["military-alert", "economic-alert", "macro-china", "geopolitics"],
    sourceFunction: "ak.macro_china_foreign_exchange_gold",
    endpoint: "/macro_china_foreign_exchange_gold",
    docUrl: "https://akshare.akfamily.xyz/data/macro/macro.html",
    method: "GET",
    valueType: EconomicDataValueType.quantity,
    defaultFrequency: MONTHLY,
    parser: {
      type: "timeseries",
      timestampField: "统计时间",
      valueFields: [
        { field: "黄金储备", label: "黄金储备", unit: "万盎司", dataType: EconomicDataValueType.quantity },
        { field: "国家外汇储备", label: "国家外汇储备", unit: "亿美元", dataType: EconomicDataValueType.quantity }
      ]
    },
    tags: ["reserves", "geopolitics", "risk"]
  }
] satisfies AkshareDataItemDefinition[];
