"use client";

import { gql, useApolloClient } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Radio,
  Space,
  Tag,
  Typography,
} from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type KnowledgeGraphImpactAnalysisModel,
  type Query,
  useKnowledgeGraphSettingsQuery,
} from "@/graphql/generated";
import {
  buildKnowledgeGraphExplorerHref,
  normalizeKnowledgeGraphSeedType,
} from "@/lib/knowledge-graph-explorer";

const { Paragraph, Text, Title } = Typography;

const EXECUTIVE_CHANGE_IMPACT_QUERY = gql`
  query GetExecutiveChangeImpactUi($input: ExecutiveChangeImpactInput!) {
    getExecutiveChangeImpact(input: $input) {
      scenario
      generatedAt
      metadata
      seed {
        id
        name
        type
        properties
      }
      candidates {
        score
        kind
        entity {
          id
          name
          type
          properties
        }
        chains {
          reason
          nodes {
            id
            name
            type
            properties
          }
          edges {
            id
            from
            to
            type
            weight
            confidence
            properties
          }
        }
      }
    }
  }
`;

const COMMODITY_MOVE_IMPACT_QUERY = gql`
  query GetCommodityMoveImpactUi($input: CommodityMoveImpactInput!) {
    getCommodityMoveImpact(input: $input) {
      scenario
      generatedAt
      metadata
      seed {
        id
        name
        type
        properties
      }
      candidates {
        score
        kind
        entity {
          id
          name
          type
          properties
        }
        chains {
          reason
          nodes {
            id
            name
            type
            properties
          }
          edges {
            id
            from
            to
            type
            weight
            confidence
            properties
          }
        }
      }
    }
  }
`;

const POLICY_EVENT_IMPACT_QUERY = gql`
  query GetPolicyEventImpactUi($input: PolicyEventImpactInput!) {
    getPolicyEventImpact(input: $input) {
      scenario
      generatedAt
      metadata
      seed {
        id
        name
        type
        properties
      }
      candidates {
        score
        kind
        entity {
          id
          name
          type
          properties
        }
        chains {
          reason
          nodes {
            id
            name
            type
            properties
          }
          edges {
            id
            from
            to
            type
            weight
            confidence
            properties
          }
        }
      }
    }
  }
`;

type ImpactScenario = "executive_change" | "commodity_move" | "policy_event";

interface ImpactFormValues {
  companyName?: string;
  commodityName?: string;
  policyName?: string;
  maxCandidates?: number;
  includeLprSnapshot?: boolean;
}

const DEFAULT_MAX_CANDIDATES = 12;

function formatJson(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function scenarioDocument(scenario: ImpactScenario) {
  if (scenario === "commodity_move") {
    return COMMODITY_MOVE_IMPACT_QUERY;
  }
  if (scenario === "policy_event") {
    return POLICY_EVENT_IMPACT_QUERY;
  }
  return EXECUTIVE_CHANGE_IMPACT_QUERY;
}

function scenarioField(scenario: ImpactScenario) {
  if (scenario === "commodity_move") {
    return "getCommodityMoveImpact";
  }
  if (scenario === "policy_event") {
    return "getPolicyEventImpact";
  }
  return "getExecutiveChangeImpact";
}

export function KnowledgeGraphImpactContent() {
  const { t } = useTranslation();
  const apolloClient = useApolloClient();
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadDashboards = permissions.includes("dashboards.read");
  const authenticated = sessionStatus === "authenticated";
  const [form] = Form.useForm<ImpactFormValues>();
  const [scenario, setScenario] = useState<ImpactScenario>("executive_change");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [analysis, setAnalysis] =
    useState<KnowledgeGraphImpactAnalysisModel | null>(null);

  const { data: settingsData, loading: settingsLoading } =
    useKnowledgeGraphSettingsQuery({
      fetchPolicy: "cache-and-network",
      skip: !authenticated || !canReadDashboards,
    });

  const isDisabledByAdmin = settingsData?.knowledgeGraphSettings?.enabled === false;

  const scenarioMeta = useMemo(
    () => ({
      executive_change: {
        title: t("knowledgeGraph.impact.scenarios.executive.title", {
          defaultValue: "Executive change",
        }),
        description: t("knowledgeGraph.impact.scenarios.executive.description", {
          defaultValue:
            "Estimate which entities or instruments are most exposed when leadership changes at a company.",
        }),
        fieldLabel: t("knowledgeGraph.impact.fields.companyName", {
          defaultValue: "Company name",
        }),
        fieldName: "companyName" as const,
        placeholder: t("knowledgeGraph.impact.placeholders.companyName", {
          defaultValue: "Enter a listed company or organization",
        }),
      },
      commodity_move: {
        title: t("knowledgeGraph.impact.scenarios.commodity.title", {
          defaultValue: "Commodity move",
        }),
        description: t("knowledgeGraph.impact.scenarios.commodity.description", {
          defaultValue:
            "Trace likely downstream winners, losers, and exposed entities from a commodity shock.",
        }),
        fieldLabel: t("knowledgeGraph.impact.fields.commodityName", {
          defaultValue: "Commodity name",
        }),
        fieldName: "commodityName" as const,
        placeholder: t("knowledgeGraph.impact.placeholders.commodityName", {
          defaultValue: "Enter a commodity, energy product, or raw material",
        }),
      },
      policy_event: {
        title: t("knowledgeGraph.impact.scenarios.policy.title", {
          defaultValue: "Policy event",
        }),
        description: t("knowledgeGraph.impact.scenarios.policy.description", {
          defaultValue:
            "Surface the entities and sectors most affected by a new policy, regulation, or official directive.",
        }),
        fieldLabel: t("knowledgeGraph.impact.fields.policyName", {
          defaultValue: "Policy or event name",
        }),
        fieldName: "policyName" as const,
        placeholder: t("knowledgeGraph.impact.placeholders.policyName", {
          defaultValue: "Enter a policy keyword or named policy event",
        }),
      },
    }),
    [t],
  );

  const currentScenarioMeta = scenarioMeta[scenario];

  const handleSubmit = async (values: ImpactFormValues) => {
    const seedValue = values[currentScenarioMeta.fieldName];
    const normalizedSeed =
      typeof seedValue === "string" ? seedValue.trim() : "";
    if (!normalizedSeed) {
      setErrorMessage(
        t("knowledgeGraph.impact.errors.seedRequired", {
          defaultValue: "Enter a seed before running the impact analysis.",
        }),
      );
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const maxCandidates = Math.max(
        1,
        Math.min(50, Math.floor(values.maxCandidates ?? DEFAULT_MAX_CANDIDATES)),
      );
      const input =
        scenario === "executive_change"
          ? { companyName: normalizedSeed, maxCandidates }
          : scenario === "commodity_move"
            ? { commodityName: normalizedSeed, maxCandidates }
            : {
                policyName: normalizedSeed,
                maxCandidates,
                includeLprSnapshot: Boolean(values.includeLprSnapshot),
              };

      const response = await apolloClient.query<
        Pick<Query, ReturnType<typeof scenarioField>>
      >({
        query: scenarioDocument(scenario),
        variables: { input },
        fetchPolicy: "network-only",
      });

      const field = scenarioField(scenario);
      setAnalysis(
        (response.data?.[field] as KnowledgeGraphImpactAnalysisModel | null) ??
          null,
      );
    } catch (error) {
      setAnalysis(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("knowledgeGraph.impact.errors.loadFailed", {
              defaultValue: "Failed to load impact analysis.",
            }),
      );
    } finally {
      setLoading(false);
    }
  };

  const openInExplorer = (name: string, type: string) => {
    router.push(
      buildKnowledgeGraphExplorerHref({
        seedName: name,
        seedType: normalizeKnowledgeGraphSeedType(type),
      }),
    );
  };

  if (!authenticated) {
    return null;
  }

  if (!canReadDashboards) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t("knowledgeGraph.impact.permissions.title", {
          defaultValue: "Knowledge graph impact requires dashboard access.",
        })}
      />
    );
  }

  if (settingsLoading) {
    return <Card loading className="content-card" />;
  }

  if (isDisabledByAdmin) {
    return (
      <Alert
        type="info"
        showIcon
        message={t("knowledgeGraph.impact.disabled.title", {
          defaultValue: "Knowledge graph analysis is disabled by an administrator.",
        })}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card className="content-card">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Title level={4} style={{ marginBottom: 8 }}>
              {t("knowledgeGraph.impact.title", {
                defaultValue: "Entity Impact Analysis",
              })}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("knowledgeGraph.impact.description", {
                defaultValue:
                  "Run scenario analysis on top of the knowledge graph to surface likely downstream exposure chains.",
              })}
            </Paragraph>
          </div>

          <Radio.Group
            value={scenario}
            onChange={(event) => {
              setScenario(event.target.value as ImpactScenario);
              setAnalysis(null);
              setErrorMessage(null);
            }}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="executive_change">
              {scenarioMeta.executive_change.title}
            </Radio.Button>
            <Radio.Button value="commodity_move">
              {scenarioMeta.commodity_move.title}
            </Radio.Button>
            <Radio.Button value="policy_event">
              {scenarioMeta.policy_event.title}
            </Radio.Button>
          </Radio.Group>

          <Alert
            type="info"
            showIcon
            message={currentScenarioMeta.title}
            description={currentScenarioMeta.description}
          />

          <Form
            form={form}
            layout="vertical"
            onFinish={(values) => {
              void handleSubmit(values);
            }}
            initialValues={{ maxCandidates: DEFAULT_MAX_CANDIDATES }}
          >
            <Form.Item
              label={currentScenarioMeta.fieldLabel}
              name={currentScenarioMeta.fieldName}
              rules={[
                {
                  required: true,
                  message: t("knowledgeGraph.impact.validation.seedRequired", {
                    defaultValue: "This field is required.",
                  }),
                },
              ]}
            >
              <Input placeholder={currentScenarioMeta.placeholder} />
            </Form.Item>

            <Space wrap align="start" style={{ display: "flex" }}>
              <Form.Item
                label={t("knowledgeGraph.impact.fields.maxCandidates", {
                  defaultValue: "Max candidates",
                })}
                name="maxCandidates"
                style={{ minWidth: 220 }}
              >
                <InputNumber min={1} max={50} style={{ width: "100%" }} />
              </Form.Item>

              {scenario === "policy_event" ? (
                <Form.Item
                  label={t("knowledgeGraph.impact.fields.includeLprSnapshot", {
                    defaultValue: "Include LPR snapshot",
                  })}
                  name="includeLprSnapshot"
                  valuePropName="checked"
                >
                  <Radio.Group
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                      {
                        label: t("common.no", { defaultValue: "No" }),
                        value: false,
                      },
                      {
                        label: t("common.yes", { defaultValue: "Yes" }),
                        value: true,
                      },
                    ]}
                  />
                </Form.Item>
              ) : null}
            </Space>

            <Space wrap>
              <Button type="primary" htmlType="submit" loading={loading}>
                {t("knowledgeGraph.impact.actions.run", {
                  defaultValue: "Run impact analysis",
                })}
              </Button>
              <Button
                onClick={() => {
                  form.resetFields();
                  setAnalysis(null);
                  setErrorMessage(null);
                }}
              >
                {t("common.reset", { defaultValue: "Reset" })}
              </Button>
            </Space>
          </Form>
        </Space>
      </Card>

      {errorMessage ? (
        <Alert
          type="error"
          showIcon
          message={t("knowledgeGraph.impact.errors.title", {
            defaultValue: "Impact analysis failed",
          })}
          description={errorMessage}
        />
      ) : null}

      {!analysis && !loading ? (
        <Card className="content-card">
          <Empty
            description={t("knowledgeGraph.impact.empty", {
              defaultValue:
                "Pick a scenario and run an analysis to inspect candidate impact chains.",
            })}
          />
        </Card>
      ) : null}

      {analysis ? (
        <>
          <Card className="content-card">
            <Descriptions column={{ xs: 1, lg: 2 }} bordered size="small">
              <Descriptions.Item
                label={t("knowledgeGraph.impact.summary.seed", {
                  defaultValue: "Seed",
                })}
              >
                <Space wrap>
                  <Text strong>{analysis.seed.name}</Text>
                  <Tag>{analysis.seed.type}</Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item
                label={t("knowledgeGraph.impact.summary.scenario", {
                  defaultValue: "Scenario",
                })}
              >
                {analysis.scenario}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("knowledgeGraph.impact.summary.generatedAt", {
                  defaultValue: "Generated at",
                })}
              >
                {analysis.generatedAt}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("knowledgeGraph.impact.summary.candidates", {
                  defaultValue: "Candidates",
                })}
              >
                {analysis.candidates.length}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <List
            dataSource={analysis.candidates}
            renderItem={(candidate, index) => {
              const metadataJson = formatJson(candidate.entity.properties);
              const collapseItems = candidate.chains.map((chain, chainIndex) => ({
                key: `${candidate.entity.id}-${chainIndex}`,
                label: `${t("knowledgeGraph.impact.chain.title", {
                  defaultValue: "Chain",
                })} ${chainIndex + 1}: ${chain.reason}`,
                children: (
                  <Space
                    direction="vertical"
                    size="small"
                    style={{ width: "100%" }}
                  >
                    <Text type="secondary">
                      {t("knowledgeGraph.impact.chain.nodes", {
                        defaultValue: "Nodes",
                      })}
                    </Text>
                    <Space wrap>
                      {chain.nodes.map((node) => (
                        <Tag key={node.id}>
                          {node.name} · {node.type}
                        </Tag>
                      ))}
                    </Space>
                    <Text type="secondary">
                      {t("knowledgeGraph.impact.chain.edges", {
                        defaultValue: "Edges",
                      })}
                    </Text>
                    <Space wrap>
                      {chain.edges.map((edge) => (
                        <Tag key={edge.id}>
                          {edge.type}
                          {typeof edge.confidence === "number"
                            ? ` · ${(edge.confidence * 100).toFixed(0)}%`
                            : ""}
                        </Tag>
                      ))}
                    </Space>
                  </Space>
                ),
              }));

              return (
                <List.Item key={candidate.entity.id}>
                  <Card className="content-card w-full">
                    <Space
                      direction="vertical"
                      size="middle"
                      style={{ width: "100%" }}
                    >
                      <Space
                        align="start"
                        style={{
                          width: "100%",
                          justifyContent: "space-between",
                        }}
                        wrap
                      >
                        <Space direction="vertical" size={4}>
                          <Space wrap>
                            <Tag color="blue">#{index + 1}</Tag>
                            <Tag>{candidate.kind}</Tag>
                            <Tag color="geekblue">
                              {t("knowledgeGraph.impact.candidate.score", {
                                defaultValue: "Score",
                              })}{" "}
                              {candidate.score.toFixed(3)}
                            </Tag>
                          </Space>
                          <Title level={5} style={{ margin: 0 }}>
                            {candidate.entity.name}
                          </Title>
                          <Text type="secondary">{candidate.entity.type}</Text>
                        </Space>
                        <Button
                          onClick={() =>
                            openInExplorer(
                              candidate.entity.name,
                              candidate.entity.type,
                            )
                          }
                        >
                          {t("knowledgeGraph.impact.actions.openExplorer", {
                            defaultValue: "Open in explorer",
                          })}
                        </Button>
                      </Space>

                      <Collapse ghost items={collapseItems} />

                      {metadataJson ? (
                        <Collapse
                          ghost
                          items={[
                            {
                              key: `${candidate.entity.id}-properties`,
                              label: t("knowledgeGraph.impact.properties", {
                                defaultValue: "Entity properties",
                              }),
                              children: (
                                <pre className="max-h-[240px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
                                  {metadataJson}
                                </pre>
                              ),
                            },
                          ]}
                        />
                      ) : null}
                    </Space>
                  </Card>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}
    </Space>
  );
}
