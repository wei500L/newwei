package archivepreparationworker

import (
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

// archiveAnchor is one taxonomy anchor document. The anchor text is the exact
// ArchiveTaxonomy buildAnchorDocument projection; its SHA-256 is the storage
// key for ArchiveVerticalAnchorEmbedding.
type archiveAnchor struct {
	Vertical       archivereading.Vertical
	AnchorID       string
	AnchorText     string
	AnchorTextHash string
}

// archiveAnchorDefinitions is the five-vertical archive taxonomy anchor set in
// ARCHIVE_VERTICAL_ORDER. Only the anchor-relevant members of the taxonomy are
// reproduced: anchor text embeds the display name and every anchor field.
var archiveAnchorDefinitions = []archiveAnchorDefinition{
	{
		Vertical:    archivereading.VerticalEastSea,
		DisplayName: "【东海】",
		Anchors: []archiveAnchorSpec{
			{
				ID:                    "maritime-deterrence",
				Definition:            "东海与日本周边海空安全、舰机活动、同盟威慑和防务姿态变化。",
				UseWhen:               []string{"日本、韩国、朝鲜相关防务部署和海空巡逻", "东海、台海周边的军事预警与安全态势"},
				TypicalSignals:        []string{"防卫白皮书", "舰机跟监", "导弹预警", "联合军演"},
				AvoidWhen:             []string{"南海岛礁争议与海警执法", "阿富汗或印巴边境冲突"},
				RepresentativePhrases: []string{"East China Sea security posture", "Japan defense update", "Taiwan Strait deterrence"},
			},
			{
				ID:                    "peninsula-missile",
				Definition:            "朝鲜半岛导弹试射、日韩应对、预警拦截与区域同盟协调。",
				UseWhen:               []string{"朝鲜半岛导弹活动和日韩安全响应", "围绕朝鲜半岛的导弹防御、情报预警"},
				TypicalSignals:        []string{"导弹试射", "预警系统", "日韩协调", "半岛局势"},
				AvoidWhen:             []string{"东盟海上争议", "纯外交会谈或制裁表态"},
				RepresentativePhrases: []string{"Korean Peninsula missile alert", "Seoul Tokyo coordination", "regional missile defense"},
			},
			{
				ID:                    "taiwan-maritime-air",
				Definition:            "台海周边海空行动、威慑表态、军演和对台周边安全态势。",
				UseWhen:               []string{"台海周边海空兵力活动", "围绕台海的威慑、预警和军演"},
				TypicalSignals:        []string{"台海周边", "海空巡航", "军演警巡", "威慑姿态"},
				AvoidWhen:             []string{"国内涉台政策治理表态", "南海航道与岛礁争议"},
				RepresentativePhrases: []string{"Taiwan Strait patrol", "cross-strait deterrence", "air and maritime activity"},
			},
		},
	},
	{
		Vertical:    archivereading.VerticalSouthSea,
		DisplayName: "【南海】",
		Anchors: []archiveAnchorSpec{
			{
				ID:                    "reef-dispute",
				Definition:            "南海岛礁主权争议、海上对峙、补给与驻守活动。",
				UseWhen:               []string{"围绕黄岩岛、仁爱礁、南沙、西沙的争议", "岛礁补给、驻守或海上对峙"},
				TypicalSignals:        []string{"仁爱礁", "黄岩岛", "岛礁补给", "对峙升级"},
				AvoidWhen:             []string{"东海或朝鲜半岛军情", "国内海洋政策治理"},
				RepresentativePhrases: []string{"South China Sea reef dispute", "Scarborough Shoal stand-off", "Spratly supply mission"},
			},
			{
				ID:                    "coast-guard-law-enforcement",
				Definition:            "南海海警执法、拦截、护航、船只碰撞和执法争议。",
				UseWhen:               []string{"海警船执法、拦阻、驱离、伴航", "涉海执法争议或碰撞事件"},
				TypicalSignals:        []string{"海警执法", "驱离", "拦截", "伴航"},
				AvoidWhen:             []string{"外交部制裁或双边会谈", "陆地边境冲突"},
				RepresentativePhrases: []string{"coast guard encounter", "maritime law enforcement", "escort and interception"},
			},
			{
				ID:                    "shipping-lane-security",
				Definition:            "南海与周边航道安全、自由航行和区域海上通道风险。",
				UseWhen:               []string{"航线安全、自由航行行动、海运风险", "东盟沿海国家围绕航道的安全争议"},
				TypicalSignals:        []string{"自由航行", "航道安全", "海运风险", "商船通道"},
				AvoidWhen:             []string{"朝鲜半岛导弹或东海巡逻", "纯粹国内港口建设政策"},
				RepresentativePhrases: []string{"freedom of navigation operation", "shipping lane security", "ASEAN coastal dispute"},
			},
		},
	},
	{
		Vertical:    archivereading.VerticalWestFront,
		DisplayName: "【西面】",
		Anchors: []archiveAnchorSpec{
			{
				ID:                    "afghanistan-instability",
				Definition:            "阿富汗局势、跨境武装活动、边境渗透与周边安全风险。",
				UseWhen:               []string{"阿富汗及周边安全变化", "跨境武装渗透和边境袭扰"},
				TypicalSignals:        []string{"武装组织", "渗透", "边境袭击", "撤离风险"},
				AvoidWhen:             []string{"东海或南海海上安全", "制裁或双边经贸摩擦"},
				RepresentativePhrases: []string{"Afghanistan security spillover", "cross-border infiltration", "militant frontier risk"},
			},
			{
				ID:                    "india-pakistan-border",
				Definition:            "印巴边境、克什米尔摩擦、停火破裂和地区安全紧张。",
				UseWhen:               []string{"印巴边境摩擦、克什米尔交火", "停火破裂、边境增兵、袭击警戒"},
				TypicalSignals:        []string{"克什米尔", "停火破裂", "边境交火", "边防部署"},
				AvoidWhen:             []string{"日韩朝导弹预警", "南海航道与海警执法"},
				RepresentativePhrases: []string{"Kashmir border clash", "India Pakistan tension", "ceasefire breakdown"},
			},
			{
				ID:                    "central-asia-frontier",
				Definition:            "中亚边境安全、地区动荡外溢和前沿维稳态势。",
				UseWhen:               []string{"中亚国家边境安全与地区不稳", "塔吉克、乌兹别克等边境协防"},
				TypicalSignals:        []string{"中亚", "边境协防", "地区动荡", "前沿维稳"},
				AvoidWhen:             []string{"内政建设与产业政策", "纯外交峰会会谈"},
				RepresentativePhrases: []string{"Central Asia frontier security", "regional instability spillover", "border security coordination"},
			},
		},
	},
	{
		Vertical:    archivereading.VerticalForeignAffairs,
		DisplayName: "【外务】",
		Anchors: []archiveAnchorSpec{
			{
				ID:                    "diplomatic-negotiation",
				Definition:            "外交沟通、峰会会谈、外长接触、双边与多边谈判。",
				UseWhen:               []string{"两国或多国外交接触、峰会、部长级会谈", "对外政策协商与国际沟通"},
				TypicalSignals:        []string{"峰会", "会谈", "外长", "联合声明"},
				AvoidWhen:             []string{"国内治理、基建、产业政策", "单纯海空军情 without diplomacy"},
				RepresentativePhrases: []string{"diplomatic summit", "bilateral talks", "multilateral negotiation"},
			},
			{
				ID:                    "sanctions-trade-friction",
				Definition:            "制裁、反制、出口管制、关税与经贸摩擦。",
				UseWhen:               []string{"制裁清单、反制措施、出口限制、关税对抗", "国际经贸博弈与政策工具"},
				TypicalSignals:        []string{"制裁", "反制", "关税", "出口管制"},
				AvoidWhen:             []string{"国内财政预算或产业扶持", "地方建设项目"},
				RepresentativePhrases: []string{"sanctions package", "export control dispute", "tariff escalation"},
			},
			{
				ID:                    "embassy-and-foreign-ministry",
				Definition:            "使馆、外交部、照会、召见与官方外事表态。",
				UseWhen:               []string{"使馆安全、外交部声明、召见、抗议、照会", "官方外事回应与国际立场表达"},
				TypicalSignals:        []string{"使馆", "外交部", "照会", "召见"},
				AvoidWhen:             []string{"部委内部治理或国内监管整治", "海警执法或边境交火现场"},
				RepresentativePhrases: []string{"embassy statement", "foreign ministry response", "diplomatic note"},
			},
		},
	},
	{
		Vertical:    archivereading.VerticalDomesticAffairs,
		DisplayName: "【内务】",
		Anchors: []archiveAnchorSpec{
			{
				ID:                    "macro-governance",
				Definition:            "国内宏观政策、财政金融治理、部委政策和经济稳增长。",
				UseWhen:               []string{"国内宏观政策、财政预算、央行与部委治理", "经济稳增长和监管政策调整"},
				TypicalSignals:        []string{"财政预算", "稳增长", "政策调整", "部委部署"},
				AvoidWhen:             []string{"外交制裁、双边峰会、外事声明", "东海南海军情"},
				RepresentativePhrases: []string{"domestic policy adjustment", "economic governance", "fiscal support package"},
			},
			{
				ID:                    "industry-and-energy",
				Definition:            "产业政策、制造业升级、能源保供、基础设施和项目建设。",
				UseWhen:               []string{"产业扶持、制造业升级、能源保供和重大项目建设", "地方基建、交通、能源工程推进"},
				TypicalSignals:        []string{"产业政策", "制造业升级", "能源保供", "重大项目"},
				AvoidWhen:             []string{"出口管制或国际经贸摩擦", "边境冲突与海警执法"},
				RepresentativePhrases: []string{"industrial policy rollout", "energy supply security", "infrastructure buildout"},
			},
			{
				ID:                    "local-governance",
				Definition:            "地方治理、社会治理、监管整治、城市群和民生治理。",
				UseWhen:               []string{"地方政府、城市治理、监管整治和民生治理", "社会治理、区域发展与地方部署"},
				TypicalSignals:        []string{"地方政府", "社会治理", "监管整治", "区域发展"},
				AvoidWhen:             []string{"驻外使团、外交表态、国际谈判", "海空军事态势"},
				RepresentativePhrases: []string{"local governance reform", "social governance campaign", "regional development plan"},
			},
		},
	},
}

type archiveAnchorDefinition struct {
	Vertical    archivereading.Vertical
	DisplayName string
	Anchors     []archiveAnchorSpec
}

type archiveAnchorSpec struct {
	ID                    string
	Definition            string
	UseWhen               []string
	TypicalSignals        []string
	AvoidWhen             []string
	RepresentativePhrases []string
}

// buildAnchorVariants reproduces ARCHIVE_VERTICAL_ANCHOR_ENTRIES including the
// vertical order and the exact anchor document text.
func buildAnchorVariants() []archiveAnchor {
	out := make([]archiveAnchor, 0, 15)
	for _, definition := range archiveAnchorDefinitions {
		for _, anchor := range definition.Anchors {
			text := buildAnchorDocument(definition.Vertical, definition.DisplayName, anchor)
			out = append(out, archiveAnchor{
				Vertical:       definition.Vertical,
				AnchorID:       anchor.ID,
				AnchorText:     text,
				AnchorTextHash: hashText(text),
			})
		}
	}
	return out
}

func buildAnchorDocument(vertical archivereading.Vertical, displayName string, anchor archiveAnchorSpec) string {
	return strings.Join([]string{
		"Vertical: " + string(vertical),
		"Display name: " + displayName,
		"Definition: " + anchor.Definition,
		"Use when: " + strings.Join(anchor.UseWhen, " | "),
		"Typical signals: " + strings.Join(anchor.TypicalSignals, " | "),
		"Do not use when: " + strings.Join(anchor.AvoidWhen, " | "),
		"Representative phrases: " + strings.Join(anchor.RepresentativePhrases, " | "),
	}, "\n")
}
