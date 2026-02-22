import { Injectable, Logger, OnModuleInit } from "@nestjs/common"

import { genMetadata } from "./data/metadata"
import { genSources } from "./data/pre-sources"
import type { Metadata, Source, SourceGetter, SourceID } from "./news-aggregator.types"
import source36kr from "./sources/_36kr"
import baiduSource from "./sources/baidu"
import bilibiliSource from "./sources/bilibili"
import cankaoxiaoxiSource from "./sources/cankaoxiaoxi"
import chongbuluoSource from "./sources/chongbuluo"
import clsSource from "./sources/cls/index"
import coolapkSource from "./sources/coolapk/index"
import doubanSource from "./sources/douban"
import douyinSource from "./sources/douyin"
import fastbullSource from "./sources/fastbull"
import freebufSource from "./sources/freebuf"
import gelonghuiSource from "./sources/gelonghui"
import ghxiSource from "./sources/ghxi"
import githubSource from "./sources/github"
import hackernewsSource from "./sources/hackernews"
import hupuSource from "./sources/hupu"
import ifengSource from "./sources/ifeng"
import iqiyiSource from "./sources/iqiyi"
import ithomeSource from "./sources/ithome"
import jin10Source from "./sources/jin10"
import juejinSource from "./sources/juejin"
import kaopuSource from "./sources/kaopu"
import kuaishouSource from "./sources/kuaishou"
import linuxdoSource from "./sources/linuxdo"
import mktnewsSource from "./sources/mktnews"
import nowcoderSource from "./sources/nowcoder"
import pcbetaSource from "./sources/pcbeta"
import producthuntSource from "./sources/producthunt"
import qqvideoSource from "./sources/qqvideo"
import smzdmSource from "./sources/smzdm"
import solidotSource from "./sources/solidot"
import sputniknewscnSource from "./sources/sputniknewscn"
import sspaiSource from "./sources/sspai"
import steamSource from "./sources/steam"
import tencentSource from "./sources/tencent"
import thepaperSource from "./sources/thepaper"
import tiebaSource from "./sources/tieba"
import toutiaoSource from "./sources/toutiao"
import v2exSource from "./sources/v2ex"
import wallstreetcnSource from "./sources/wallstreetcn"
import weiboSource from "./sources/weibo"
import xueqiuSource from "./sources/xueqiu"
import zaobaoSource from "./sources/zaobao"
import zhihuSource from "./sources/zhihu"

type SourceModuleExport = (() => Promise<unknown>) | Record<string, () => Promise<unknown>>

@Injectable()
export class NewsAggregatorRegistryService implements OnModuleInit {
  private readonly logger = new Logger(NewsAggregatorRegistryService.name)

  private sources: Record<SourceID, Source> = {} as Record<SourceID, Source>
  private getters: Record<SourceID, SourceGetter> = {} as Record<SourceID, SourceGetter>
  private columns: Metadata = {} as Metadata

  onModuleInit() {
    this.sources = genSources()
    this.getters = this.buildGetters()
    this.columns = genMetadata(this.sources)

    this.logger.log(
      `news-aggregator initialized: ${Object.keys(this.sources).length} sources, ${Object.keys(this.getters).length} getters`,
    )
  }

  getSource(id: SourceID): Source | undefined {
    return this.sources[id]
  }

  getSources(): Record<SourceID, Source> {
    return this.sources
  }

  getGetter(id: SourceID): SourceGetter | undefined {
    return this.getters[id]
  }

  getColumns(): Metadata {
    return this.columns
  }

  getMetadata(): { sources: Record<SourceID, Source>, columns: Metadata } {
    return {
      sources: this.sources,
      columns: this.columns,
    }
  }

  private buildGetters(): Record<SourceID, SourceGetter> {
    const modules: Record<string, SourceModuleExport> = {
      "36kr": source36kr,
      "baidu": baiduSource,
      "bilibili": bilibiliSource,
      "cankaoxiaoxi": cankaoxiaoxiSource,
      "chongbuluo": chongbuluoSource,
      "cls": clsSource,
      "coolapk": coolapkSource,
      "douban": doubanSource,
      "douyin": douyinSource,
      "fastbull": fastbullSource,
      "freebuf": freebufSource,
      "gelonghui": gelonghuiSource,
      "ghxi": ghxiSource,
      "github": githubSource,
      "hackernews": hackernewsSource,
      "hupu": hupuSource,
      "ifeng": ifengSource,
      "iqiyi": iqiyiSource,
      "ithome": ithomeSource,
      "jin10": jin10Source,
      "juejin": juejinSource,
      "kaopu": kaopuSource,
      "kuaishou": kuaishouSource,
      "linuxdo": linuxdoSource,
      "mktnews": mktnewsSource,
      "nowcoder": nowcoderSource,
      "pcbeta": pcbetaSource,
      "producthunt": producthuntSource,
      "qqvideo": qqvideoSource,
      "smzdm": smzdmSource,
      "solidot": solidotSource,
      "sputniknewscn": sputniknewscnSource,
      "sspai": sspaiSource,
      "steam": steamSource,
      "tencent": tencentSource,
      "thepaper": thepaperSource,
      "tieba": tiebaSource,
      "toutiao": toutiaoSource,
      "v2ex": v2exSource,
      "wallstreetcn": wallstreetcnSource,
      "weibo": weiboSource,
      "xueqiu": xueqiuSource,
      "zaobao": zaobaoSource,
      "zhihu": zhihuSource,
    }

    const getters: Partial<Record<SourceID, SourceGetter>> = {}

    for (const [id, getterModule] of Object.entries(modules)) {
      if (typeof getterModule === "function") {
        getters[id as SourceID] = getterModule as SourceGetter
        continue
      }

      Object.entries(getterModule).forEach(([sourceId, getter]) => {
        getters[sourceId as SourceID] = getter as SourceGetter
      })
    }

    return getters as Record<SourceID, SourceGetter>
  }
}
