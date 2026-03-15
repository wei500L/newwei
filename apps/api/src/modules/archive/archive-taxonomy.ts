import {
  ARCHIVE_VERTICAL_ORDER,
  ArchiveVertical,
} from './archive.types';

export interface ArchiveTaxonomyAnchorDefinition {
  id: string;
  definition: string;
  useWhen: readonly string[];
  typicalSignals: readonly string[];
  avoidWhen: readonly string[];
  representativePhrases: readonly string[];
}

export interface ArchiveTaxonomyVerticalDefinition {
  displayName: string;
  summary: string;
  countries: readonly string[];
  strongKeywords: readonly string[];
  weakKeywords: readonly string[];
  excludedKeywords: readonly string[];
  conflictKeywords: readonly string[];
  anchors: readonly ArchiveTaxonomyAnchorDefinition[];
}

export interface ArchiveTaxonomyAnchorEntry {
  vertical: ArchiveVertical;
  anchorId: string;
  anchorText: string;
}

const buildAnchorDocument = (
  vertical: ArchiveVertical,
  definition: ArchiveTaxonomyVerticalDefinition,
  anchor: ArchiveTaxonomyAnchorDefinition,
): string =>
  [
    `Vertical: ${vertical}`,
    `Display name: ${definition.displayName}`,
    `Definition: ${anchor.definition}`,
    `Use when: ${anchor.useWhen.join(' | ')}`,
    `Typical signals: ${anchor.typicalSignals.join(' | ')}`,
    `Do not use when: ${anchor.avoidWhen.join(' | ')}`,
    `Representative phrases: ${anchor.representativePhrases.join(' | ')}`,
  ].join('\n');

export const ARCHIVE_VERTICAL_TAXONOMY: Record<
  ArchiveVertical,
  ArchiveTaxonomyVerticalDefinition
> = {
  [ArchiveVertical.EAST_SEA]: {
    displayName: '【东海】',
    summary:
      '聚焦东海、朝鲜半岛、日本、韩国与台海周边海空安全、同盟威慑和导弹预警态势。',
    countries: ['JPN', 'KOR', 'PRK', 'TWN'],
    strongKeywords: [
      '东海',
      '朝鲜半岛',
      '日本海',
      '钓鱼岛',
      '台海',
      '防卫白皮书',
      '导弹预警',
      '海空安全',
      '联合军演',
      'east china sea',
      'korean peninsula',
      'taiwan strait',
      'japan defense',
      'missile launch',
      'naval patrol',
      'regional deterrence',
    ],
    weakKeywords: [
      '日本',
      '韩国',
      '朝鲜',
      '东京',
      '首尔',
      '防空识别区',
      '联盟威慑',
      '舰机',
      'air defense',
      'alliance exercise',
    ],
    excludedKeywords: [
      '南海',
      '黄岩岛',
      '仁爱礁',
      '南沙',
      '西沙',
      'spratly',
      'scarborough',
    ],
    conflictKeywords: [
      '黄岩岛',
      '仁爱礁',
      'spratly',
      'scarborough',
      '阿富汗',
      '克什米尔',
      'kashmir',
    ],
    anchors: [
      {
        id: 'maritime-deterrence',
        definition:
          '东海与日本周边海空安全、舰机活动、同盟威慑和防务姿态变化。',
        useWhen: [
          '日本、韩国、朝鲜相关防务部署和海空巡逻',
          '东海、台海周边的军事预警与安全态势',
        ],
        typicalSignals: [
          '防卫白皮书',
          '舰机跟监',
          '导弹预警',
          '联合军演',
        ],
        avoidWhen: [
          '南海岛礁争议与海警执法',
          '阿富汗或印巴边境冲突',
        ],
        representativePhrases: [
          'East China Sea security posture',
          'Japan defense update',
          'Taiwan Strait deterrence',
        ],
      },
      {
        id: 'peninsula-missile',
        definition:
          '朝鲜半岛导弹试射、日韩应对、预警拦截与区域同盟协调。',
        useWhen: [
          '朝鲜半岛导弹活动和日韩安全响应',
          '围绕朝鲜半岛的导弹防御、情报预警',
        ],
        typicalSignals: [
          '导弹试射',
          '预警系统',
          '日韩协调',
          '半岛局势',
        ],
        avoidWhen: [
          '东盟海上争议',
          '纯外交会谈或制裁表态',
        ],
        representativePhrases: [
          'Korean Peninsula missile alert',
          'Seoul Tokyo coordination',
          'regional missile defense',
        ],
      },
      {
        id: 'taiwan-maritime-air',
        definition:
          '台海周边海空行动、威慑表态、军演和对台周边安全态势。',
        useWhen: [
          '台海周边海空兵力活动',
          '围绕台海的威慑、预警和军演',
        ],
        typicalSignals: [
          '台海周边',
          '海空巡航',
          '军演警巡',
          '威慑姿态',
        ],
        avoidWhen: [
          '国内涉台政策治理表态',
          '南海航道与岛礁争议',
        ],
        representativePhrases: [
          'Taiwan Strait patrol',
          'cross-strait deterrence',
          'air and maritime activity',
        ],
      },
    ],
  },
  [ArchiveVertical.SOUTH_SEA]: {
    displayName: '【南海】',
    summary:
      '聚焦南海岛礁、海警执法、自由航行、航道安全和东盟沿海争议。',
    countries: ['BRN', 'IDN', 'KHM', 'LAO', 'MYS', 'MMR', 'PHL', 'SGP', 'THA', 'VNM'],
    strongKeywords: [
      '南海',
      '黄岩岛',
      '仁爱礁',
      '南沙',
      '西沙',
      '岛礁',
      '海警',
      '自由航行',
      'south china sea',
      'scarborough',
      'spratly',
      'paracel',
      'coast guard',
      'maritime claims',
      'freedom of navigation',
    ],
    weakKeywords: [
      '菲律宾',
      '越南',
      '马来西亚',
      '印尼',
      '东盟',
      '航道',
      '海上执法',
      'asean maritime',
      'shipping lane',
      'maritime confrontation',
    ],
    excludedKeywords: [
      '东海',
      '朝鲜半岛',
      '台海',
      '克什米尔',
      '阿富汗',
      'korean peninsula',
    ],
    conflictKeywords: [
      '东海',
      '钓鱼岛',
      '台海',
      '导弹预警',
      '克什米尔',
      'afghanistan',
    ],
    anchors: [
      {
        id: 'reef-dispute',
        definition:
          '南海岛礁主权争议、海上对峙、补给与驻守活动。',
        useWhen: [
          '围绕黄岩岛、仁爱礁、南沙、西沙的争议',
          '岛礁补给、驻守或海上对峙',
        ],
        typicalSignals: [
          '仁爱礁',
          '黄岩岛',
          '岛礁补给',
          '对峙升级',
        ],
        avoidWhen: [
          '东海或朝鲜半岛军情',
          '国内海洋政策治理',
        ],
        representativePhrases: [
          'South China Sea reef dispute',
          'Scarborough Shoal stand-off',
          'Spratly supply mission',
        ],
      },
      {
        id: 'coast-guard-law-enforcement',
        definition:
          '南海海警执法、拦截、护航、船只碰撞和执法争议。',
        useWhen: [
          '海警船执法、拦阻、驱离、伴航',
          '涉海执法争议或碰撞事件',
        ],
        typicalSignals: [
          '海警执法',
          '驱离',
          '拦截',
          '伴航',
        ],
        avoidWhen: [
          '外交部制裁或双边会谈',
          '陆地边境冲突',
        ],
        representativePhrases: [
          'coast guard encounter',
          'maritime law enforcement',
          'escort and interception',
        ],
      },
      {
        id: 'shipping-lane-security',
        definition:
          '南海与周边航道安全、自由航行和区域海上通道风险。',
        useWhen: [
          '航线安全、自由航行行动、海运风险',
          '东盟沿海国家围绕航道的安全争议',
        ],
        typicalSignals: [
          '自由航行',
          '航道安全',
          '海运风险',
          '商船通道',
        ],
        avoidWhen: [
          '朝鲜半岛导弹或东海巡逻',
          '纯粹国内港口建设政策',
        ],
        representativePhrases: [
          'freedom of navigation operation',
          'shipping lane security',
          'ASEAN coastal dispute',
        ],
      },
    ],
  },
  [ArchiveVertical.WEST_FRONT]: {
    displayName: '【西面】',
    summary:
      '聚焦阿富汗、中亚、印巴、克什米尔及西部边境安全、渗透和反恐态势。',
    countries: ['AFG', 'IND', 'IRN', 'KAZ', 'KGZ', 'PAK', 'TJK', 'TKM', 'UZB'],
    strongKeywords: [
      '西面',
      '阿富汗',
      '中亚',
      '印巴',
      '克什米尔',
      '边境冲突',
      '边防',
      '渗透',
      '反恐',
      'afghanistan',
      'central asia',
      'india pakistan',
      'kashmir',
      'border clash',
      'militant activity',
    ],
    weakKeywords: [
      '巴基斯坦',
      '塔吉克',
      '乌兹别克',
      '吉尔吉斯',
      '哈萨克',
      '边境安全',
      'frontier tension',
      'cross-border',
      'counterterrorism',
    ],
    excludedKeywords: [
      '南海',
      '东海',
      '海警',
      '外交部',
      '制裁',
      '国内政策',
    ],
    conflictKeywords: [
      '海警',
      '南沙',
      '东海',
      '台海',
      '外交照会',
      '地方政府',
    ],
    anchors: [
      {
        id: 'afghanistan-instability',
        definition:
          '阿富汗局势、跨境武装活动、边境渗透与周边安全风险。',
        useWhen: [
          '阿富汗及周边安全变化',
          '跨境武装渗透和边境袭扰',
        ],
        typicalSignals: [
          '武装组织',
          '渗透',
          '边境袭击',
          '撤离风险',
        ],
        avoidWhen: [
          '东海或南海海上安全',
          '制裁或双边经贸摩擦',
        ],
        representativePhrases: [
          'Afghanistan security spillover',
          'cross-border infiltration',
          'militant frontier risk',
        ],
      },
      {
        id: 'india-pakistan-border',
        definition:
          '印巴边境、克什米尔摩擦、停火破裂和地区安全紧张。',
        useWhen: [
          '印巴边境摩擦、克什米尔交火',
          '停火破裂、边境增兵、袭击警戒',
        ],
        typicalSignals: [
          '克什米尔',
          '停火破裂',
          '边境交火',
          '边防部署',
        ],
        avoidWhen: [
          '日韩朝导弹预警',
          '南海航道与海警执法',
        ],
        representativePhrases: [
          'Kashmir border clash',
          'India Pakistan tension',
          'ceasefire breakdown',
        ],
      },
      {
        id: 'central-asia-frontier',
        definition:
          '中亚边境安全、地区动荡外溢和前沿维稳态势。',
        useWhen: [
          '中亚国家边境安全与地区不稳',
          '塔吉克、乌兹别克等边境协防',
        ],
        typicalSignals: [
          '中亚',
          '边境协防',
          '地区动荡',
          '前沿维稳',
        ],
        avoidWhen: [
          '内政建设与产业政策',
          '纯外交峰会会谈',
        ],
        representativePhrases: [
          'Central Asia frontier security',
          'regional instability spillover',
          'border security coordination',
        ],
      },
    ],
  },
  [ArchiveVertical.FOREIGN_AFFAIRS]: {
    displayName: '【外务】',
    summary:
      '聚焦外交、制裁、双多边关系、经贸摩擦、外事沟通与国际博弈。',
    countries: [],
    strongKeywords: [
      '外交',
      '制裁',
      '反制',
      '关税',
      '贸易摩擦',
      '双边关系',
      '多边会谈',
      '峰会',
      '使馆',
      '外交照会',
      '出口管制',
      '联合声明',
      'diplomacy',
      'sanction',
      'countermeasure',
      'trade dispute',
      'summit',
      'multilateral talks',
      'embassy',
      'foreign ministry',
      'export control',
    ],
    weakKeywords: [
      '国际关系',
      '国际合作',
      '伙伴关系',
      '外长会',
      '国际谈判',
      '对外政策',
      'bilateral',
      'multilateral',
      'foreign affairs',
      'united nations',
    ],
    excludedKeywords: [
      '国内政策',
      '地方政府',
      '基建',
      '能源保供',
      '产业政策',
      'industrial policy',
      'energy security',
      '五年规划',
      '财政预算',
      '监管整治',
    ],
    conflictKeywords: [
      '地方政府',
      '五年规划',
      '能源保供',
      '产业升级',
      'industrial policy',
      'energy security',
      '社会治理',
    ],
    anchors: [
      {
        id: 'diplomatic-negotiation',
        definition:
          '外交沟通、峰会会谈、外长接触、双边与多边谈判。',
        useWhen: [
          '两国或多国外交接触、峰会、部长级会谈',
          '对外政策协商与国际沟通',
        ],
        typicalSignals: [
          '峰会',
          '会谈',
          '外长',
          '联合声明',
        ],
        avoidWhen: [
          '国内治理、基建、产业政策',
          '单纯海空军情 without diplomacy',
        ],
        representativePhrases: [
          'diplomatic summit',
          'bilateral talks',
          'multilateral negotiation',
        ],
      },
      {
        id: 'sanctions-trade-friction',
        definition:
          '制裁、反制、出口管制、关税与经贸摩擦。',
        useWhen: [
          '制裁清单、反制措施、出口限制、关税对抗',
          '国际经贸博弈与政策工具',
        ],
        typicalSignals: [
          '制裁',
          '反制',
          '关税',
          '出口管制',
        ],
        avoidWhen: [
          '国内财政预算或产业扶持',
          '地方建设项目',
        ],
        representativePhrases: [
          'sanctions package',
          'export control dispute',
          'tariff escalation',
        ],
      },
      {
        id: 'embassy-and-foreign-ministry',
        definition:
          '使馆、外交部、照会、召见与官方外事表态。',
        useWhen: [
          '使馆安全、外交部声明、召见、抗议、照会',
          '官方外事回应与国际立场表达',
        ],
        typicalSignals: [
          '使馆',
          '外交部',
          '照会',
          '召见',
        ],
        avoidWhen: [
          '部委内部治理或国内监管整治',
          '海警执法或边境交火现场',
        ],
        representativePhrases: [
          'embassy statement',
          'foreign ministry response',
          'diplomatic note',
        ],
      },
    ],
  },
  [ArchiveVertical.DOMESTIC_AFFAIRS]: {
    displayName: '【内务】',
    summary:
      '聚焦国内政策、经济治理、产业与能源策略、地方建设和社会治理。',
    countries: [],
    strongKeywords: [
      '内务',
      '国内',
      '政策调整',
      '五年规划',
      '基建',
      '能源战略',
      '财政预算',
      '地方政府',
      '监管整治',
      '产业政策',
      '社会治理',
      '稳增长',
      '保供',
      'domestic policy',
      'economic governance',
      'industrial policy',
      'energy security',
      'local government',
      'social governance',
      'infrastructure',
    ],
    weakKeywords: [
      '国务院',
      '发改委',
      '央行',
      '部委',
      '省份',
      '就业',
      '房市',
      '制造业升级',
      'regulation',
      'fiscal stimulus',
    ],
    excludedKeywords: [
      '外交',
      '制裁',
      '使馆',
      '峰会',
      '停火谈判',
      '军演',
      '海警对峙',
      '外交照会',
    ],
    conflictKeywords: [
      '制裁',
      '峰会',
      '使馆',
      '外交部',
      '双边关系',
      '出口管制',
    ],
    anchors: [
      {
        id: 'macro-governance',
        definition:
          '国内宏观政策、财政金融治理、部委政策和经济稳增长。',
        useWhen: [
          '国内宏观政策、财政预算、央行与部委治理',
          '经济稳增长和监管政策调整',
        ],
        typicalSignals: [
          '财政预算',
          '稳增长',
          '政策调整',
          '部委部署',
        ],
        avoidWhen: [
          '外交制裁、双边峰会、外事声明',
          '东海南海军情',
        ],
        representativePhrases: [
          'domestic policy adjustment',
          'economic governance',
          'fiscal support package',
        ],
      },
      {
        id: 'industry-and-energy',
        definition:
          '产业政策、制造业升级、能源保供、基础设施和项目建设。',
        useWhen: [
          '产业扶持、制造业升级、能源保供和重大项目建设',
          '地方基建、交通、能源工程推进',
        ],
        typicalSignals: [
          '产业政策',
          '制造业升级',
          '能源保供',
          '重大项目',
        ],
        avoidWhen: [
          '出口管制或国际经贸摩擦',
          '边境冲突与海警执法',
        ],
        representativePhrases: [
          'industrial policy rollout',
          'energy supply security',
          'infrastructure buildout',
        ],
      },
      {
        id: 'local-governance',
        definition:
          '地方治理、社会治理、监管整治、城市群和民生治理。',
        useWhen: [
          '地方政府、城市治理、监管整治和民生治理',
          '社会治理、区域发展与地方部署',
        ],
        typicalSignals: [
          '地方政府',
          '社会治理',
          '监管整治',
          '区域发展',
        ],
        avoidWhen: [
          '驻外使团、外交表态、国际谈判',
          '海空军事态势',
        ],
        representativePhrases: [
          'local governance reform',
          'social governance campaign',
          'regional development plan',
        ],
      },
    ],
  },
};

export const ARCHIVE_VERTICAL_ANCHOR_ENTRIES: ArchiveTaxonomyAnchorEntry[] =
  ARCHIVE_VERTICAL_ORDER.flatMap((vertical) => {
    const definition = ARCHIVE_VERTICAL_TAXONOMY[vertical];
    return definition.anchors.map((anchor) => ({
      vertical,
      anchorId: anchor.id,
      anchorText: buildAnchorDocument(vertical, definition, anchor),
    }));
  });
