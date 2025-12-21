import type { EconomicDataFrequency} from "@prisma/client";
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

const createEnglishOhlcFields = (unit: string): AkshareDataFieldConfig[] => [
  {
    field: "open",
    label: "开盘价",
    unit,
    dataType: EconomicDataValueType.price
  },
  {
    field: "high",
    label: "最高价",
    unit,
    dataType: EconomicDataValueType.price
  },
  {
    field: "low",
    label: "最低价",
    unit,
    dataType: EconomicDataValueType.price
  },
  {
    field: "close",
    label: "收盘价",
    unit,
    dataType: EconomicDataValueType.price
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
    endpoint: "/macro/china/cpi",
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
    endpoint: "/macro/china/gdp",
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
    endpoint: "/macro/china/money_supply",
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
    endpoint: "/macro/china/ppi/yearly",
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
    endpoint: "/macro/china/pmi_yearly",
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
    endpoint: "/macro/china/reserve-requirement-ratio",
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
    endpoint: "/macro/usa/unemployment_rate",
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
    endpoint: "/macro/usa/services_pmi",
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
    endpoint: "/macro/china/fdi",
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
    endpoint: "/macro/china/trade/exports/yoy",
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
    endpoint: "/macro/china/trade/imports/yoy",
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
    id: "us-core-pce",
    slug: "us_core_pce",
    displayName: "美国核心PCE物价指数",
    categories: ["economic-alert", "macro-us"],
    sourceFunction: "ak.macro_usa_core_pce_price",
    endpoint: "/api/macro/usa/core_pce_price",
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
    endpoint: "/api/macro/usa/non_farm",
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
    endpoint: "/api/macro/usa/cpi",
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
    endpoint: "/api/macro/usa/gdp",
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
    endpoint: "/api/macro/usa/ppi",
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
    endpoint: "/api/macro/usa/pmi",
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
    id: "macro-fx-sentiment",
    slug: "macro_fx_sentiment",
    displayName: "外汇情绪指数",
    categories: ["sentiment", "fx"],
    sourceFunction: "ak.macro_fx_sentiment",
    endpoint: "/macro_fx_sentiment",
    docUrl: "https://akshare.akfamily.xyz/data/fx/fx.html",
    method: "GET",
    valueType: EconomicDataValueType.percent,
    defaultUnit: "percent",
    defaultFrequency: HOURLY,
    parser: {
      type: "timeseries",
      timestampField: "date",
      valueFields: [
        { field: "AUDJPY", label: "AUD/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "AUDUSD", label: "AUD/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURAUD", label: "EUR/AUD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURJPY", label: "EUR/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "EURUSD", label: "EUR/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "GBPJPY", label: "GBP/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "GBPUSD", label: "GBP/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "NZDUSD", label: "NZD/USD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDCAD", label: "USD/CAD", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDCHF", label: "USD/CHF", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDJPY", label: "USD/JPY", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "USDX", label: "USDX", unit: "%", dataType: EconomicDataValueType.percent },
        { field: "XAUUSD", label: "XAU/USD", unit: "%", dataType: EconomicDataValueType.percent }
      ]
    }
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
  }
] satisfies AkshareDataItemDefinition[];
