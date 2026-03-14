# Akshare 接口审计表

审计时间：2026-03-14

> 说明：当前环境没有可直接调用的 Context7 MCP 客户端。本次 Phase 1 改用 Akshare 官方文档、1.18.39 官方源码和 1.18.39 实测返回结果做对照；无法稳定实测的项会明确标注。

## 审计依据

- https://github.com/akfamily/akshare/tree/main/docs/data/futures
- https://github.com/akfamily/akshare/tree/main/docs/data/spot
- https://github.com/akfamily/akshare/tree/main/docs/data/bond
- https://github.com/akfamily/akshare/tree/main/docs/data/stock
- https://github.com/akfamily/akshare/tree/main/docs/data/dc
- https://github.com/akfamily/akshare/tree/main/docs/data/macro
- https://github.com/akfamily/akshare/tree/main/docs/data/fx
- https://github.com/akfamily/akshare/tree/main/docs/data/article
- https://github.com/akfamily/akshare/tree/main/docs/data/hf
- https://github.com/akfamily/akshare/blob/main/akshare/futures/futures_zh_sina.py
- https://github.com/akfamily/akshare/blob/main/akshare/futures_derivative/futures_index_sina.py
- https://github.com/akfamily/akshare/blob/main/akshare/spot/spot_sge.py
- https://github.com/akfamily/akshare/blob/main/akshare/bond/bond_china.py
- https://github.com/akfamily/akshare/blob/main/akshare/bond/bond_em.py
- https://github.com/akfamily/akshare/blob/main/akshare/index/index_stock_zh.py
- https://github.com/akfamily/akshare/blob/main/akshare/stock_feature/stock_hist_em.py
- https://github.com/akfamily/akshare/blob/main/akshare/economic/macro_china.py
- https://github.com/akfamily/akshare/blob/main/akshare/economic/macro_usa.py
- https://github.com/akfamily/akshare/blob/main/akshare/fx/fx_quote.py
- https://github.com/akfamily/akshare/blob/main/akshare/currency/currency_safe.py
- https://github.com/akfamily/akshare/blob/main/akshare/article/epu_index.py
- https://github.com/akfamily/akshare/blob/main/akshare/hf/hf_sp500.py

## 定义级审计表

| # | 定义 ID | endpoint | akshare 函数 | 当前参数 | 文档参数 | 参数匹配 | 当前解析字段 | 文档返回列 | 字段匹配 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gold-futures-realtime | /futures_zh_spot | futures_zh_spot | symbol=AU0, market=CF, adjust=0 | symbol, market, adjust | ✅ | timestamp=time; current_price | symbol, time, open, high, low, current_price, bid_price, ask_price, buy_vol, sell_vol, hold, volume, avg_price, last_close, last_settle_price | ✅ | 1.18.39 源码签名已使用 symbol；`subscribe_list -> symbol` 仅剩向后兼容价值。 |
| 2 | gold-futures-main | /futures_main_sina | futures_main_sina | symbol=AU0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 3 | silver-futures-realtime | /futures_zh_spot | futures_zh_spot | symbol=AG0, market=CF, adjust=0 | symbol, market, adjust | ✅ | timestamp=time; current_price | symbol, time, open, high, low, current_price, bid_price, ask_price, buy_vol, sell_vol, hold, volume, avg_price, last_close, last_settle_price | ✅ | 1.18.39 源码签名已使用 symbol；`subscribe_list -> symbol` 仅剩向后兼容价值。 |
| 4 | crude-oil-futures-main | /futures_main_sina | futures_main_sina | symbol=SC0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 5 | copper-futures-main | /futures_main_sina | futures_main_sina | symbol=CU0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 6 | bond-futures-main | /futures_main_sina | futures_main_sina | symbol=T0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 7 | natural-gas-futures-main | /futures_main_sina | futures_main_sina | symbol=NG0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 8 | rebar-futures-main | /futures_main_sina | futures_main_sina | symbol=RB0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 9 | hotcoil-futures-main | /futures_main_sina | futures_main_sina | symbol=HC0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 10 | aluminum-futures-main | /futures_main_sina | futures_main_sina | symbol=AL0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 11 | rubber-futures-main | /futures_main_sina | futures_main_sina | symbol=RU0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 12 | cotton-futures-main | /futures_main_sina | futures_main_sina | symbol=CF0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 13 | rice-futures-main | /futures_main_sina | futures_main_sina | symbol=RR0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 14 | wheat-futures-main | /futures_main_sina | futures_main_sina | symbol=WH0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 15 | corn-futures-main | /futures_main_sina | futures_main_sina | symbol=C0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 16 | soybean-futures-main | /futures_main_sina | futures_main_sina | symbol=A0 | symbol, start_date, end_date | ✅ | timestamp=日期; 开盘价, 最高价, 最低价, 收盘价 | 日期, 开盘价, 最高价, 最低价, 收盘价, 成交量, 持仓量, 动态结算价 | ✅ | 当前定义只取 OHLC，属于返回列的有效子集。 |
| 17 | platinum-spot-sge | /spot_hist_sge | spot_hist_sge | symbol=Pt99.95 | symbol | ✅ | timestamp=交易日期; 收盘价 | date, open, close, low, high | ❌ | 1.18.39 实测列为 date/open/close/low/high；当前 parser 仍用 交易日期/收盘价。 |
| 18 | palladium-spot-sge | /spot_hist_sge | spot_hist_sge | symbol=Pd99.95 | symbol | ✅ | timestamp=交易日期; 收盘价 | date, open, close, low, high | ❌ | 1.18.39 实测列为 date/open/close/low/high；当前 parser 仍用 交易日期/收盘价。 |
| 19 | china-treasury-yield-curve | /bond_china_yield | bond_china_yield | 无 | start_date, end_date | ⚠️ | date=日期; 3月, 6月, 1年, 3年, 5年, 7年, 10年, 30年 | 曲线名称, 日期, 3月, 6月, 1年, 3年, 5年, 7年, 10年, 30年 | ⚠️ | akshare 需要 start_date/end_date；当前定义未传参会落回固定默认区间 2020-02-04..2021-01-24。返回还含 曲线名称 维度，当前 parser 未区分，可能混入非国债曲线。 |
| 20 | us-treasury-yield-curve | /bond_zh_us_rate | bond_zh_us_rate | 无 | start_date | ✅ | date=日期; 美国国债收益率2年, 美国国债收益率5年, 美国国债收益率10年, 美国国债收益率30年 | 日期, 中国国债收益率2年, 中国国债收益率5年, 中国国债收益率10年, 中国国债收益率30年, 中国国债收益率10年-2年, 中国GDP年增率, 美国国债收益率2年, 美国国债收益率5年, 美国国债收益率10年, 美国国债收益率30年, 美国国债收益率10年-2年, 美国GDP年增率 | ✅ | 当前定义只取美国 2Y/5Y/10Y/30Y，为返回列子集。 |
| 21 | shanghai-composite-index | /stock_zh_index_daily | stock_zh_index_daily | symbol=sh000001 | symbol | ✅ | timestamp=date; open, high, low, close | date, open, high, low, close, volume | ✅ | 当前定义只取 OHLC，忽略 volume。 |
| 22 | csi300-index | /stock_zh_index_daily | stock_zh_index_daily | symbol=sh000300 | symbol | ✅ | timestamp=date; open, high, low, close | date, open, high, low, close, volume | ✅ | 当前定义只取 OHLC，忽略 volume。 |
| 23 | shenzhen-component-index | /stock_zh_index_daily | stock_zh_index_daily | symbol=sz399001 | symbol | ✅ | timestamp=date; open, high, low, close | date, open, high, low, close, volume | ✅ | 当前定义只取 OHLC，忽略 volume。 |
| 24 | csi1000-index | /stock_zh_index_daily | stock_zh_index_daily | symbol=sh000852 | symbol | ✅ | timestamp=date; open, high, low, close | date, open, high, low, close, volume | ✅ | 当前定义只取 OHLC，忽略 volume。 |
| 25 | bitcoin-spot-price | /crypto_js_spot | crypto_js_spot | 无 | 无 | ✅ | timestamp=更新时间; 最近报价 | 市场, 交易品种, 最近报价, 涨跌额, 涨跌幅, 24小时最高, 24小时最低, 24小时成交量, 更新时间 | ✅ | 无函数入参，项目通过 filter=交易品种:BTCUSD 在 API 层做后过滤。 |
| 26 | sp500-index | /hf_sp_500 | hf_sp_500 | year=CURRENT_YEAR(=2026) | year | ⚠️ | timestamp=date; open, high, low, close | date, open, high, low, close, price | ✅ | 当前 defaultParams 实际会展开为 year=CURRENT_YEAR；按当前日期 2026-03-14 即 2026。hf_sp_500 官方仅支持 2012-2018，实测 2026 返回 HTTP 404。 |
| 27 | china-cpi | /macro_china_cpi | macro_china_cpi | 无 | 无 | ✅ | period=月份; 全国-当月, 全国-同比增长, 城市-环比增长, 农村-环比增长 | 月份, 全国-当月, 全国-同比增长, 全国-环比增长, 全国-累计, 城市-当月, 城市-同比增长, 城市-环比增长, 城市-累计, 农村-当月, 农村-同比增长, 农村-环比增长, 农村-累计 | ✅ | 当前定义解析 4 个核心指标列，属于返回列子集。 |
| 28 | china-gdp | /macro_china_gdp | macro_china_gdp | 无 | 无 | ✅ | period=季度; 国内生产总值-绝对值, 国内生产总值-同比增长 | 季度, 国内生产总值-绝对值, 国内生产总值-同比增长, 第一产业-绝对值, 第一产业-同比增长, 第二产业-绝对值, 第二产业-同比增长, 第三产业-绝对值, 第三产业-同比增长 | ✅ | 当前定义解析 GDP 总量与同比两列。 |
| 29 | china-money-supply | /macro_china_money_supply | macro_china_money_supply | 无 | 无 | ✅ | period=月份; 货币和准货币(M2)-数量(亿元), 货币和准货币(M2)-同比增长 | 月份, 货币和准货币(M2)-数量(亿元), 货币和准货币(M2)-同比增长, 货币和准货币(M2)-环比增长, 货币(M1)-数量(亿元), 货币(M1)-同比增长, 货币(M1)-环比增长, 流通中的现金(M0)-数量(亿元), 流通中的现金(M0)-同比增长, 流通中的现金(M0)-环比增长 | ✅ | 当前定义解析 M2 数量与同比两列。 |
| 30 | usd-cny-spot | /fx_spot_quote | fx_spot_quote | 无 | 无 | ✅ | 卖报价 | 货币对, 买报价, 卖报价 | ✅ | 无函数入参，项目通过 filter=货币对:USD/CNY 在 API 层做后过滤。 |
| 31 | eur-cny-spot | /fx_spot_quote | fx_spot_quote | 无 | 无 | ✅ | 卖报价 | 货币对, 买报价, 卖报价 | ✅ | 无函数入参，项目通过 filter=货币对:EUR/CNY 在 API 层做后过滤。 |
| 32 | china-fx-gold-reserve | /macro_china_fx_gold | macro_china_fx_gold | 无 | 无 | ✅ | period=月份; 黄金储备-数值, 国家外汇储备-数值 | 月份, 黄金储备-数值, 黄金储备-同比, 黄金储备-环比, 国家外汇储备-数值, 国家外汇储备-同比, 国家外汇储备-环比 | ✅ | 当前定义只解析黄金储备与外汇储备两条绝对值序列。 |
| 33 | china-ppi | /macro_china_ppi_yearly | macro_china_ppi_yearly | 无 | 无 | ✅ | period=日期; 今值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义只解析 今值，属于返回列子集。 |
| 34 | china-pmi | /macro_china_pmi_yearly | macro_china_pmi_yearly | 无 | 无 | ✅ | period=日期; 今值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义只解析 今值，属于返回列子集。 |
| 35 | china-rrr | /macro_china_reserve_requirement_ratio | macro_china_reserve_requirement_ratio | 无 | 无 | ✅ | period=公布时间; 大型金融机构-调整后, 中小金融机构-调整后 | 公布时间, 生效时间, 大型金融机构-调整前, 大型金融机构-调整后, 大型金融机构-调整幅度, 中小金融机构-调整前, 中小金融机构-调整后, 中小金融机构-调整幅度, 消息公布次日指数涨跌-上证, 消息公布次日指数涨跌-深证, 备注 | ✅ |  |
| 36 | us-unemployment-rate | /macro_usa_unemployment_rate | macro_usa_unemployment_rate | 无 | 无 | ✅ | timestamp=date; current_value | 商品, 日期, 今值, 预测值, 前值 | ❌ | 1.18.39 实测列为 商品/日期/今值/预测值/前值；当前 parser 仍按 date/current_value 旧英文字段解析。 |
| 37 | china-fdi-monthly | /macro_china_fdi | macro_china_fdi | 无 | 无 | ✅ | period=月份; 当月, 当月-同比增长, 当月-环比增长, 累计, 累计-同比增长 | 月份, 当月, 当月-同比增长, 当月-环比增长, 累计, 累计-同比增长 | ✅ |  |
| 38 | china-exports-yoy | /macro_china_exports_yoy | macro_china_exports_yoy | 无 | 无 | ✅ | period=日期; 今值, 预测值, 前值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义解析 日期/今值/预测值/前值，与 1.18.39 实测一致。 |
| 39 | china-imports-yoy | /macro_china_imports_yoy | macro_china_imports_yoy | 无 | 无 | ✅ | period=日期; 今值, 预测值, 前值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义解析 日期/今值/预测值/前值，与 1.18.39 实测一致。 |
| 40 | china-bdti-index | /macro_china_bdti_index | macro_china_bdti_index | 无 | 无 | ✅ | timestamp=日期; 最新值, 涨跌幅 | 日期, 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | ✅ | 1.18.39 实测仍返回 8 列（含近3月/6月/1年/2年/3年涨跌幅），当前定义兼容。 |
| 41 | global-shipping-bdi | /macro_shipping_bdi | macro_shipping_bdi | 无 | 无 | ✅ | timestamp=日期; 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | 日期, 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | ✅ | 1.18.39 实测仍返回 8 列（含近3月/6月/1年/2年/3年涨跌幅），当前定义兼容。 |
| 42 | global-shipping-bci | /macro_shipping_bci | macro_shipping_bci | 无 | 无 | ✅ | timestamp=日期; 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | 日期, 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | ✅ | 1.18.39 实测仍返回 8 列（含近3月/6月/1年/2年/3年涨跌幅），当前定义兼容。 |
| 43 | global-shipping-bpi | /macro_shipping_bpi | macro_shipping_bpi | 无 | 无 | ✅ | timestamp=日期; 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | 日期, 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | ✅ | 1.18.39 实测仍返回 8 列（含近3月/6月/1年/2年/3年涨跌幅），当前定义兼容。 |
| 44 | global-shipping-bcti | /macro_shipping_bcti | macro_shipping_bcti | 无 | 无 | ✅ | timestamp=日期; 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | 日期, 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | ✅ | 1.18.39 实测仍返回 8 列（含近3月/6月/1年/2年/3年涨跌幅），当前定义兼容。 |
| 45 | china-epu-index | /article_epu_index | article_epu_index | symbol=China | symbol | ✅ | year/month=year/month; China_Policy_Index | year, month, China_Policy_Index | ✅ | 已按各默认 symbol 实测列名，不再需要“需人工验证”。 |
| 46 | global-epu-index | /article_epu_index | article_epu_index | symbol=Global | symbol | ✅ | year/month=Year/Month; GEPU_ppp | Year, Month, GEPU_ppp | ✅ | 已按各默认 symbol 实测列名，不再需要“需人工验证”。 |
| 47 | us-epu-index | /article_epu_index | article_epu_index | symbol=USA | symbol | ✅ | year/month=Year/Month; News_Based_Policy_Uncert_Index | Year, Month, News_Based_Policy_Uncert_Index | ✅ | 已按各默认 symbol 实测列名，不再需要“需人工验证”。 |
| 48 | europe-epu-index | /article_epu_index | article_epu_index | symbol=Europe | symbol | ✅ | year/month=Year/Month; European_News_Index | Year, Month, European_News_Index | ✅ | 已按各默认 symbol 实测列名，不再需要“需人工验证”。 |
| 49 | uk-epu-index | /article_epu_index | article_epu_index | symbol=UK | symbol | ✅ | year/month=Year/Month; UK_EPU_Index | Year, Month, UK_EPU_Index | ✅ | 已按各默认 symbol 实测列名，不再需要“需人工验证”。 |
| 50 | japan-epu-index | /article_epu_index | article_epu_index | symbol=Japan | symbol | ✅ | year/month=Year/Month; Economic_Policy_Uncertainty_Index | Year, Month, Economic_Policy_Uncertainty_Index, Fiscal_Policy_Uncertainty_Index, Monetary_Policy_Uncertainty_Index, Trade_Policy_Uncertainty_Index, Exchange_Rate_Policy_Uncertainty_Index | ✅ | 已按各默认 symbol 实测列名，不再需要“需人工验证”。 |
| 51 | shipping-bdi-latest | /macro_shipping_bdi | macro_shipping_bdi | 无 | 无 | ✅ | timestamp=日期; 最新值 | 日期, 最新值, 涨跌幅, 近3月涨跌幅, 近6月涨跌幅, 近1年涨跌幅, 近2年涨跌幅, 近3年涨跌幅 | ✅ | 1.18.39 实测仍返回 8 列（含近3月/6月/1年/2年/3年涨跌幅），当前定义兼容。 |
| 52 | us-core-pce | /macro_usa_core_pce_price | macro_usa_core_pce_price | 无 | 无 | ✅ | timestamp=date; current_value, predicted_value, previous_value | 商品, 日期, 今值, 预测值, 前值 | ❌ | 1.18.39 实测列为 商品/日期/今值/预测值/前值；当前 parser 仍按 date/current_value/predicted_value/previous_value 旧英文字段解析。 |
| 53 | us-non-farm-payrolls | /macro_usa_non_farm | macro_usa_non_farm | 无 | 无 | ✅ | timestamp=date; current_value, predicted_value, previous_value | 商品, 日期, 今值, 预测值, 前值 | ❌ | 1.18.39 实测列为 商品/日期/今值/预测值/前值；当前 parser 仍按 date/current_value/predicted_value/previous_value 旧英文字段解析。 |
| 54 | us-cpi-monthly | /macro_usa_cpi_monthly | macro_usa_cpi_monthly | 无 | 无 | ✅ | period=日期; 今值, 预测值, 前值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义解析 日期/今值/预测值/前值，与 1.18.39 实测一致。 |
| 55 | us-gdp-monthly | /macro_usa_gdp_monthly | macro_usa_gdp_monthly | 无 | 无 | ✅ | period=日期; 今值, 预测值, 前值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义解析 日期/今值/预测值/前值，与 1.18.39 实测一致。 |
| 56 | us-ppi-monthly | /macro_usa_ppi | macro_usa_ppi | 无 | 无 | ✅ | period=日期; 今值, 预测值, 前值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义解析 日期/今值/预测值/前值，与 1.18.39 实测一致。 |
| 57 | us-manufacturing-pmi | /macro_usa_pmi | macro_usa_pmi | 无 | 无 | ✅ | period=日期; 今值, 预测值, 前值 | 商品, 日期, 今值, 预测值, 前值 | ✅ | 当前定义解析 日期/今值/预测值/前值，与 1.18.39 实测一致。 |
| 58 | china-international-tourism-fx | /macro_china_international_tourism_fx | macro_china_international_tourism_fx | 无 | 无 | ✅ | period=统计年度; 数量, 比重 | 统计年度, 指标, 数量, 比重 | ⚠️ | 字段名本身仍存在，但原表含 指标 维度；当前 parser 未设置 categoryField=指标，可能把不同指标序列折叠到同一 sourceField。 |
| 59 | china-fx-mid-rates | /currency_boc_safe | currency_boc_safe | 无 | 无 | ✅ | period=日期; 美元, 欧元, 英镑, 日元, 港元, 澳元, 加元, 新加坡元, 瑞士法郎, 新西兰元 | 日期, 美元, 欧元, 日元, 港元, 英镑, 澳元, 新西兰元, 新加坡元, 瑞士法郎, 加元, 澳门元, 林吉特, 卢布, 兰特, 韩元, 迪拉姆, 里亚尔, 福林, 兹罗提, 丹麦克朗, 瑞典克朗, 挪威克朗, 里拉, 比索, 泰铢 | ✅ | 1.18.39 实测仍是无参宽表；当前定义只取主要货币列的子集。 |
| 60 | rmb-fx-spot-quotes | /fx_spot_quote | fx_spot_quote | 无 | 无 | ✅ | category=货币对; 买报价, 卖报价 | 货币对, 买报价, 卖报价 | ✅ | 上游无 symbol/pair 入参；若网关对外暴露按货币对过滤，仍需保留网关侧 post-filter。 |
| 61 | crypto-js-spot | /crypto_js_spot | crypto_js_spot | 无 | 无 | ✅ | category=instrument; price, vol24h | 市场, 交易品种, 最近报价, 涨跌额, 涨跌幅, 24小时最高, 24小时最低, 24小时成交量, 更新时间 | ❌ | 1.18.39 实测列为 市场/交易品种/最近报价/涨跌额/涨跌幅/24小时最高/24小时最低/24小时成交量/更新时间；当前定义仍用 instrument/price/vol24h。 |

## Gateway-only 审计项

| 项目 | 位置 | 1.18.39 结论 | 现状评估 | 建议 |
|---|---|---|---|---|
| `futures_zh_spot` `subscribe_list -> symbol` | `infra/akshare/main.py::_apply_compat_params` | 1.18.39 源码签名已是 `symbol, market, adjust`。 | 项目当前 61 条定义都没有使用 `subscribe_list`；该分支对当前定义不是必需。 | 若需要兼容历史/外部调用方可保留；否则可在升级时删除。 |
| `stock_zh_a_spot_em` `symbol/code` 过滤 | `infra/akshare/main.py::_apply_compat_params` | 1.18.39 `stock_zh_a_spot_em()` 仍然无入参，官方文档与源码都要求先拉整表再自行按 `代码/名称` 过滤。 | 项目当前没有对应 `AKSHARE_DATA_DEFINITIONS` 条目，但网关增强逻辑本身仍然有价值。 | 保留该 post-filter 分支；若未来新增此 endpoint 的定义，可直接复用。 |

## 风险项与修复建议

### ❌ 高风险

1. `spot_hist_sge`
   - 差异：1.18.39 实测返回 `date/open/close/low/high`，当前两个定义仍写 `交易日期` 和 `收盘价`。
   - 建议：更新 `parser.timestampField` 为 `date`，`parser.valueFields` 为 `close`，并同步单位说明。
   - 影响：升级后两个 SGE 现货定义会直接解析不到历史时间轴。
2. `macro_usa_unemployment_rate` / `macro_usa_non_farm` / `macro_usa_core_pce_price`
   - 差异：1.18.39 实测已返回中文列 `商品/日期/今值/预测值/前值`，当前仍按旧英文字段 `date/current_value/...` 解析。
   - 建议：把 parser 字段统一改为中文列名，或改为和 `us-cpi-monthly` 同一套 `macro` 配置风格。
   - 影响：升级后这 3 条定义会静默丢值。
3. `crypto_js_spot` 的 `crypto-js-spot` 定义
   - 差异：当前仍按 `instrument/price/vol24h` 英文字段建模；1.18.39 实测返回中文列。
   - 建议：删除旧英文字段定义，或重写为 `交易品种/最近报价/24小时成交量/更新时间`。
   - 影响：该定义升级后无法正常解析。

### ⚠️ 中风险

1. `hf_sp_500`
   - 差异：函数仍叫 `hf_sp_500(year)`，但官方只支持 `2012-2018`。项目当前 `defaultParams.year = CURRENT_YEAR`，在当前日期会展开成 `2026`，实测返回 404。
   - 建议：把 `defaultParams.year` 改为受支持的固定年份，或改为运行时动态回退到最近可用年份 `2018`。
2. `bond_china_yield`
   - 差异：签名仍是 `start_date,end_date`；项目未传参会落回 akshare 内置固定默认区间 `20200204..20210124`，并且结果含 `曲线名称` 维度。
   - 建议：显式传滚动日期区间，并补充对 `曲线名称` 的过滤或下沉成维度。
3. `macro_china_international_tourism_fx`
   - 差异：字段名仍兼容，但结果包含 `指标` 维度；当前 parser 未设置 `categoryField`，可能折叠不同指标。
   - 建议：补 `categoryField: "指标"`，或拆成更明确的数据项。

## 迁移实施方案

### 目标

- 在不影响现网采集稳定性的前提下，把 `infra/akshare/requirements.txt` 从 `akshare==1.17.94` 升到 `1.18.39`。
- 先修定义和解析器，再升版本，避免“升级后才发现静默丢值”。
- 所有变更以文档中已识别的高风险定义为优先，不在同一批次夹带无关重构。

### 迁移定性

- 这次迁移不是“只改依赖版本”的升级，而是“代码适配 + 版本升级”的组合迁移。
- 最小必要改动面在 TypeScript 侧：`apps/api/src/modules/akshare/akshare.definitions.ts` 必须修改。
- Python 网关 `infra/akshare/main.py` 对 `1.18.39` 没有必须修改项；现有兼容逻辑大多还能继续工作。
- 如果希望降低后续 Akshare 升级的隐性风险，建议同时补测试和 parser 防御性校验。

### 批次划分

#### Batch 0：冻结基线

1. 记录当前线上或测试环境 7 天内关键指标样本：
   - `gold_futures_realtime`
   - `platinum_spot_sge`
   - `us_unemployment_rate`
   - `bitcoin_spot_price`
   - `sp500_index`
2. 导出当前版本 `1.17.94` 下的网关响应样本和解析后落库样本，作为升级前基线。
3. 给 `apps/api/src/modules/akshare/akshare.definitions.ts` 当前相关条目打快照，便于逐项比对。

#### Batch 1：先修高风险定义，不升版本

1. 修 `spot_hist_sge`
   - 文件：`apps/api/src/modules/akshare/akshare.definitions.ts`
   - 调整：`timestampField` 从 `交易日期` 改为 `date`
   - 调整：`valueFields` 从 `收盘价` 改为 `close`
   - 目标条目：`platinum-spot-sge`、`palladium-spot-sge`
2. 修 3 条美国宏观旧英文字段定义
   - 条目：`us-unemployment-rate`、`us-non-farm-payrolls`、`us-core-pce`
   - 调整：把 parser 从旧英文字段映射切到中文列 `日期/今值/预测值/前值`
   - 建议：与 `us-cpi-monthly` / `us-gdp-monthly` / `us-ppi-monthly` / `us-manufacturing-pmi` 统一成同一类 parser 风格
3. 修 `crypto-js-spot`
   - 条目：`crypto-js-spot`
   - 调整：删除或替换 `instrument/price/vol24h`，改为 `交易品种/最近报价/24小时成交量`
   - 注意：同函数下 `bitcoin-spot-price` 已兼容，不应误改坏

#### Batch 2：修中风险配置，不升版本

1. 修 `hf_sp_500`
   - 文件：`apps/api/src/modules/akshare/akshare.definitions.ts`
   - 调整：`defaultParams.year` 不再使用 `CURRENT_YEAR`
   - 推荐：固定到 `2018`，或在服务层做“超范围年份回退到 2018”
2. 修 `bond_china_yield`
   - 补 `defaultParams.start_date/end_date`，避免落回 Akshare 内置历史默认区间
   - 明确是否需要在网关或 service 层按 `曲线名称` 过滤，只保留目标国债曲线
3. 修 `macro_china_international_tourism_fx`
   - 给 parser 增加 `categoryField: "指标"`
   - 或拆成多条定义，分别按 `指标` 落不同时间序列

#### Batch 3：本地/测试环境升版本

1. 更新：
   - `infra/akshare/requirements.txt`
   - 如有镜像构建参数，还需同步 `infra/akshare/Dockerfile`
2. 重建 Python 网关环境，确认实际安装版本为 `1.18.39`
3. 在测试环境对本报告 61 条相关定义跑一轮全量 smoke test：
   - 网关 HTTP 200/500/404 分布
   - parser 是否产出数据点
   - 时间戳是否仍是源数据时间而不是当前时间

#### Batch 4：灰度与回滚

1. 先灰度到低频任务或单环境，不要直接切全量调度。
2. 观察 24 小时：
   - 任务失败率
   - 每条定义的产点数量
   - 最新点时间是否异常回退到“当前时间”
   - 与 Batch 0 基线相比的值域偏差
3. 若出现批量空值或时间轴异常：
   - 先回滚 Python 网关镜像 / requirements 版本
   - 保留已修 definition 变更，优先判断是上游接口波动还是字段映射问题

### 文件级迁移清单

1. `infra/akshare/requirements.txt`
   - 升级 `akshare==1.17.94 -> 1.18.39`
2. `infra/akshare/Dockerfile`
   - 若通过 `AKSHARE_VERSION` 构建镜像，确认默认值与 requirements 一致
3. `apps/api/src/modules/akshare/akshare.definitions.ts`
   - 本次迁移的主要修改面
4. `apps/api/src/modules/akshare/parsers/*.ts`
   - 若要统一美国宏观 parser 风格，可能需要少量调整
5. `infra/akshare/main.py`
   - `futures_zh_spot` 的 `subscribe_list -> symbol` 可保留也可清理
   - `stock_zh_a_spot_em` 的 post-filter 建议保留

### 代码适配矩阵

| 文件 | 是否必须修改 | 改动类型 | 具体内容 |
|---|---|---|---|
| `apps/api/src/modules/akshare/akshare.definitions.ts` | 必须 | 定义字段适配 | 修 `spot_hist_sge` 两条的 `timestampField/valueFields`；修 `us-unemployment-rate`、`us-non-farm-payrolls`、`us-core-pce` 的 parser 字段；修 `crypto-js-spot` 的中文列映射；修 `sp500-index` 的 `defaultParams.year`；补 `bond_china_yield` 的显式日期参数与必要过滤；给 `macro_china_international_tourism_fx` 增 `categoryField`。 |
| `apps/api/src/modules/akshare/akshare.definitions.spec.ts` | 建议 | 回归测试 | 新增断言覆盖 `spot_hist_sge`、3 条美国宏观、`crypto-js-spot`、`sp500-index` 默认年份、`bond_china_yield` 默认参数。 |
| `apps/api/src/modules/akshare/parsers/base.parser.ts` | 可选但建议 | 防御性校验 | 增加“配置字段缺失时告警/抛错”的保护，避免再次出现字段漂移后静默回退到 `new Date()`。 |
| `apps/api/src/modules/akshare/parsers/*.ts` | 视实现选择 | parser 风格统一 | 若希望统一美国宏观处理方式，可把 3 条旧英文字段定义切到和 `us-cpi-monthly` 同一 parser 风格；若只改 definition，则这里可以不动。 |
| `apps/api/src/modules/akshare/akshare.service.ts` | 视方案选择 | 过滤与验收 | 如果决定对 `bond_china_yield` 做业务级过滤/校验，可在这里加“按 `曲线名称` 过滤”或“解析为空时 fail fast”；若仅靠 definition.filter 表达即可，则可以不改。 |
| `infra/akshare/main.py` | 非必须 | 兼容逻辑清理 | `futures_zh_spot` 的 `subscribe_list -> symbol` 可保留兼容；`stock_zh_a_spot_em` 的 post-filter 建议保留。 |
| `infra/akshare/requirements.txt` | 必须 | 版本升级 | 将 `akshare==1.17.94` 升到 `1.18.39`。 |
| `infra/akshare/Dockerfile` | 必须（若镜像由变量控制版本） | 构建版本同步 | 确保镜像构建时安装的 Akshare 版本和 `requirements.txt` 一致。 |

### 最小必要代码改动

如果目标是“用最小改动完成 `1.17.94 -> 1.18.39` 迁移”，最少需要做下面两类代码修改：

1. 修改 `apps/api/src/modules/akshare/akshare.definitions.ts`
   - 这是本次迁移唯一明确必改的业务代码文件。
   - 不改它，至少 6 条定义会在 `1.18.39` 下失效或产生错误数据。
2. 修改版本文件
   - `infra/akshare/requirements.txt`
   - 以及可能受 `AKSHARE_VERSION` 影响的 `infra/akshare/Dockerfile`

换句话说，最小闭环不是“只改一行 requirements”，而是“先改 definition，再改版本”。

### 推荐的代码改法

#### 方案 A：最小修补

- 只修 `akshare.definitions.ts` 中已识别的 6 条高风险定义和 3 条中风险配置。
- 优点：改动面最小，落地快。
- 缺点：下一次上游字段漂移时，仍可能出现静默丢值。

#### 方案 B：最小修补 + 防御性增强

- 在方案 A 基础上：
  - 补 `akshare.definitions.spec.ts`
  - 在 `base.parser.ts` 或 `akshare.service.ts` 中增加缺字段告警/失败保护
- 优点：后续升级更稳，问题暴露更早。
- 缺点：改动会比方案 A 稍大。

推荐优先采用方案 B。

### 具体代码修改建议

#### `apps/api/src/modules/akshare/akshare.definitions.ts`

1. `spot_hist_sge`
   - `platinum-spot-sge`
   - `palladium-spot-sge`
   - 改 `timestampField: "交易日期" -> "date"`
   - 改 `valueFields[].field: "收盘价" -> "close"`
2. 美国宏观 3 条旧英文字段定义
   - `us-unemployment-rate`
   - `us-non-farm-payrolls`
   - `us-core-pce`
   - 不再使用 `date/current_value/predicted_value/previous_value`
   - 改为对齐 `商品/日期/今值/预测值/前值`
3. `crypto-js-spot`
   - 移除 `instrument/price/vol24h`
   - 改为 `交易品种/最近报价/24小时成交量`
4. `sp500-index`
   - `defaultParams.year` 不再用 `CURRENT_YEAR`
   - 固定到 `2018` 或实现回退逻辑
5. `china-treasury-yield-curve`
   - 补 `defaultParams.start_date/end_date`
   - 必要时增加 `filter: { field: "曲线名称", equals: "..." }`
6. `china-international-tourism-fx`
   - 增 `categoryField: "指标"`

#### `apps/api/src/modules/akshare/akshare.definitions.spec.ts`

建议新增至少 5 组断言：

1. `spot_hist_sge` 两条定义使用 `date/close`
2. `us-unemployment-rate` 使用中文字段
3. `us-non-farm-payrolls` 使用中文字段
4. `us-core-pce` 使用中文字段
5. `crypto-js-spot` 使用中文字段
6. `sp500-index` 默认年份不再取当前年

#### `apps/api/src/modules/akshare/parsers/base.parser.ts`

建议增加一个非阻塞或可配置的防御性保护：

- 当 `timestampField/dateField/periodField/yearField/monthField` 在记录里不存在时：
  - 测试环境直接抛错；或
  - 生产环境至少打 warning 日志

这样可以避免 `spot_hist_sge` 这类“字段改名后 silently fallback 到当前时间”的问题再次发生。

#### `apps/api/src/modules/akshare/akshare.service.ts`

这里不是本次迁移的必改点，但有两个推荐增强：

1. 对 `bond_china_yield` 增加结果过滤或空解析保护
   - 防止把多条 `曲线名称` 混成一条时间序列
2. 对“定义存在但解析点数为 0”的场景增加失败告警
   - 避免字段漂移时任务表面成功、实际没有数据

### 验证清单

1. 逐项验证高风险定义：
   - `platinum-spot-sge`
   - `palladium-spot-sge`
   - `us-unemployment-rate`
   - `us-non-farm-payrolls`
   - `us-core-pce`
   - `crypto-js-spot`
2. 逐项验证中风险定义：
   - `sp500-index`
   - `china-treasury-yield-curve`
   - `china-international-tourism-fx`
3. 抽样验证稳定定义，确保没有回归：
   - `gold-futures-realtime`
   - `shanghai-composite-index`
   - `china-cpi`
   - `usd-cny-spot`
   - `china-fx-mid-rates`
   - `china-epu-index`

### 推荐执行顺序

1. 先改 `akshare.definitions.ts`
2. 再补必要 parser / service 逻辑
3. 跑 smoke test
4. 最后才升级 `requirements.txt`
5. 灰度观察后再全量切换

### 完成判定

- 高风险 6 条定义全部可正常产点
- `hf_sp_500` 不再因默认年份越界报错
- `bond_china_yield` 不再落回历史默认区间
- 关键样本与 Batch 0 基线在可接受范围内
- Python 网关日志中无新增批量 500 错误

## 升级影响评估：`1.17.94 -> 1.18.39`

- 可直接升级或仅需常规回归的函数：`futures_zh_spot`、`futures_main_sina`、`bond_zh_us_rate`、`stock_zh_index_daily`、`macro_china_cpi`、`macro_china_gdp`、`macro_china_money_supply`、`macro_china_ppi_yearly`、`macro_china_pmi_yearly`、`macro_usa_cpi_monthly`、`macro_usa_gdp_monthly`、`macro_usa_ppi`、`macro_usa_pmi`、`fx_spot_quote`、`currency_boc_safe`、航运系列、`article_epu_index`。
- 升级前必须先修的定义：`spot_hist_sge` 两条、`us-unemployment-rate`、`us-non-farm-payrolls`、`us-core-pce`、`crypto-js-spot`。
- 升级前建议同步修的配置：`sp500-index` 的默认年份、`bond_china_yield` 的默认日期区间与曲线过滤、`macro_china_international_tourism_fx` 的 `categoryField`。

## 结论

当前 Akshare 集成不是“直接把 `requirements.txt` 从 `1.17.94` 升到 `1.18.39`”就可以收工的类型。高风险破坏点集中在 6 条定义：2 条 `spot_hist_sge`、3 条美国宏观旧英文字段定义、1 条 `crypto_js_spot` 旧英文字段定义；另有 `hf_sp_500` 默认年份和 `bond_china_yield` 默认日期区间会在升级后继续埋雷。
