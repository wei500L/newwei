"use client";

import { SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Skeleton, Slider, Space, Tag, Typography, message } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { useGetKnowledgeGraphSubgraphQuery, useKnowledgeGraphSettingsQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { usePendingAction } from "@/hooks/use-pending-action";
import { buildKnowledgeGraphExplorerHref } from "@/lib/knowledge-graph-explorer";

const { Text } = Typography;

const NODE_TYPE_CONFIG: Record<string, { color: string; index: number }> = {
  company: { color: "#2563eb", index: 0 },
  industry: { color: "#16a34a", index: 1 },
  person: { color: "#f97316", index: 2 },
  policy: { color: "#ef4444", index: 3 },
  commodity: { color: "#a855f7", index: 4 },
  instrument: { color: "#0ea5e9", index: 5 },
  organization: { color: "#64748b", index: 6 }
};

const DEFAULT_NODE_TYPE = { color: "#94a3b8", index: 7 };
const LAST_ENTITY_STORAGE_KEY = "dashboard.knowledgeGraph.lastEntity";

const getNodeTypeConfig = (type: string) => {
  const normalized = type.trim().toLowerCase();
  return NODE_TYPE_CONFIG[normalized] ?? DEFAULT_NODE_TYPE;
};

const buildDegreeMap = (edges: { from: string; to: string }[]) => {
  const map = new Map<string, number>();
  for (const edge of edges) {
    map.set(edge.from, (map.get(edge.from) ?? 0) + 1);
    map.set(edge.to, (map.get(edge.to) ?? 0) + 1);
  }
  return map;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

interface NodeMeta {
  id: string;
  name: string;
  type: string;
  degree: number;
  isSeed: boolean;
}

export interface KnowledgeGraph3DProps {
  defaultSeed?: string;
}

export function KnowledgeGraph3D({ defaultSeed }: KnowledgeGraph3DProps) {
  const { t } = useTranslation();
  const { colors } = useChartTheme();
  const { data: session, status: sessionStatus } = useSession();
  const authenticated = sessionStatus === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadDashboards = permissions.includes("dashboards.read");
  const [messageApi, contextHolder] = message.useMessage();
  const [seedDraft, setSeedDraft] = useState("");
  const [seedName, setSeedName] = useState<string>("");
  const [maxDepth, setMaxDepth] = useState<number>(2);
  const [maxNodes, setMaxNodes] = useState<number>(120);
  const [selectedNode, setSelectedNode] = useState<NodeMeta | null>(null);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const {
    data: settingsData,
    loading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings
  } = useKnowledgeGraphSettingsQuery({
    fetchPolicy: "cache-and-network",
    skip: !authenticated || !canReadDashboards
  });
  const { pending: refreshingSettings, run: refreshSettings } = usePendingAction(
    () => refetchSettings(),
  );

  const settings = settingsData?.knowledgeGraphSettings;
  const isDisabledByAdmin = settings?.enabled === false;

  useEffect(() => {
    const normalized = (defaultSeed ?? "").trim();
    if (normalized) {
      if (!seedName) {
        setSeedDraft(normalized);
        setSeedName(normalized);
      }
      return;
    }
    if (seedName || !authenticated || !canReadDashboards) {
      return;
    }
    try {
      const saved = window.localStorage.getItem(LAST_ENTITY_STORAGE_KEY)?.trim();
      if (!saved) {
        return;
      }
      setSeedDraft(saved);
      setSeedName(saved);
    } catch {
      // ignore storage failures
    }
  }, [authenticated, canReadDashboards, defaultSeed, seedName]);

  const handleSearch = useCallback(
    (value?: string) => {
      const next = (value ?? seedDraft).trim();
      if (!next) {
        messageApi.warning(t("dashboard.charts.knowledgeGraphSeedRequired", { defaultValue: "Enter an entity name" }));
        return;
      }
      setSeedName(next);
      try {
        window.localStorage.setItem(LAST_ENTITY_STORAGE_KEY, next);
      } catch {
        // ignore storage failures
      }
    },
    [messageApi, seedDraft, t]
  );

  const { data, loading, error, refetch } = useGetKnowledgeGraphSubgraphQuery({
    variables: {
      input: {
        seedName,
        maxDepth,
        maxNodes
      }
    },
    fetchPolicy: "cache-first",
    skip: !authenticated || !canReadDashboards || isDisabledByAdmin || !seedName
  });
  const { pending: refreshingGraph, run: refreshGraph } = usePendingAction(
    () => refetch(),
  );

  const graph = data?.getKnowledgeGraphSubgraph ?? null;
  const degreeMap = useMemo(() => (graph ? buildDegreeMap(graph.edges) : new Map<string, number>()), [graph]);
  const explorerHref = buildKnowledgeGraphExplorerHref({
    seedName,
    maxDepth,
    maxNodes
  });

  useEffect(() => {
    if (!graph || !containerRef.current) {
      return;
    }

    const dom = containerRef.current;
    dom.innerHTML = "";

    const nodes = graph.nodes;
    const edges = graph.edges;
    if (nodes.length === 0) {
      return;
    }

    const width = Math.max(1, dom.clientWidth);
    const height = Math.max(1, dom.clientHeight);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    camera.position.set(0, 0, 80);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height);
    dom.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.55);
    keyLight.position.set(1, 1, 1);
    scene.add(keyLight);

    const nodeIndex = new Map<string, number>();
    nodes.forEach((node, idx) => {
      nodeIndex.set(node.id, idx);
    });

    const nodeGeometry = new THREE.SphereGeometry(1, 16, 16);
    const nodeObjects: { meta: NodeMeta; mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> }[] = [];

    for (const node of nodes) {
      const cfg = getNodeTypeConfig(node.type);
      const degree = degreeMap.get(node.id) ?? 0;
      const isSeed = node.id === graph.seed.id;
      const size = clamp(0.85 + degree * 0.12 + (isSeed ? 0.7 : 0), 0.9, 3.2);

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(cfg.color),
        roughness: 0.55,
        metalness: 0.1,
        emissive: new THREE.Color(isSeed ? (colors?.primary ?? "#1f3b7b") : "#000000"),
        emissiveIntensity: isSeed ? 0.22 : 0
      });
      const mesh = new THREE.Mesh(nodeGeometry, material);
      mesh.scale.setScalar(size);
      scene.add(mesh);

      nodeObjects.push({
        meta: {
          id: node.id,
          name: node.name,
          type: node.type,
          degree,
          isSeed
        },
        mesh
      });
    }

    const edgePairs: [number, number][] = [];
    for (const edge of edges) {
      const fromIdx = nodeIndex.get(edge.from);
      const toIdx = nodeIndex.get(edge.to);
      if (fromIdx === undefined || toIdx === undefined) {
        continue;
      }
      edgePairs.push([fromIdx, toIdx]);
    }

    const edgePositions = new Float32Array(edgePairs.length * 6);
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(colors?.border ?? "#94a3b8"),
      transparent: true,
      opacity: 0.55
    });
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(edgeLines);

    const count = nodeObjects.length;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const forces = new Float32Array(count * 3);

    const radius = 26;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const y = ((i % 11) - 5) * 1.8;
      const x = Math.cos(angle) * radius * (0.6 + Math.random() * 0.4);
      const z = Math.sin(angle) * radius * (0.6 + Math.random() * 0.4);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      velocities[i * 3] = 0;
      velocities[i * 3 + 1] = 0;
      velocities[i * 3 + 2] = 0;
      nodeObjects[i]!.mesh.position.set(x, y, z);
    }

    const repulsionK = 1200 / Math.max(1, Math.sqrt(count));
    const springK = 0.015;
    const restLength = 12;
    const centerK = 0.0025;
    const damping = 0.86;
    const maxSpeed = 18;

    const applyForces = (dt: number) => {
      forces.fill(0);

      for (let i = 0; i < count; i += 1) {
        const ix = i * 3;
        const ax = positions[ix]!;
        const ay = positions[ix + 1]!;
        const az = positions[ix + 2]!;
        for (let j = i + 1; j < count; j += 1) {
          const jx = j * 3;
          const bx = positions[jx]!;
          const by = positions[jx + 1]!;
          const bz = positions[jx + 2]!;
          let dx = ax - bx;
          let dy = ay - by;
          let dz = az - bz;
          const distSq = dx * dx + dy * dy + dz * dz + 0.08;
          const strength = repulsionK / distSq;
          dx *= strength;
          dy *= strength;
          dz *= strength;
          forces[ix] = forces[ix]! + dx;
          forces[ix + 1] = forces[ix + 1]! + dy;
          forces[ix + 2] = forces[ix + 2]! + dz;
          forces[jx] = forces[jx]! - dx;
          forces[jx + 1] = forces[jx + 1]! - dy;
          forces[jx + 2] = forces[jx + 2]! - dz;
        }
      }

      for (const [a, b] of edgePairs) {
        const ax = a * 3;
        const bx = b * 3;
        const dx = positions[bx]! - positions[ax]!;
        const dy = positions[bx + 1]! - positions[ax + 1]!;
        const dz = positions[bx + 2]! - positions[ax + 2]!;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
        const diff = dist - restLength;
        const strength = springK * diff;
        const fx = (dx / dist) * strength;
        const fy = (dy / dist) * strength;
        const fz = (dz / dist) * strength;
        forces[ax] = forces[ax]! + fx;
        forces[ax + 1] = forces[ax + 1]! + fy;
        forces[ax + 2] = forces[ax + 2]! + fz;
        forces[bx] = forces[bx]! - fx;
        forces[bx + 1] = forces[bx + 1]! - fy;
        forces[bx + 2] = forces[bx + 2]! - fz;
      }

      for (let i = 0; i < count; i += 1) {
        const ix = i * 3;
        forces[ix] = forces[ix]! - positions[ix]! * centerK;
        forces[ix + 1] = forces[ix + 1]! - positions[ix + 1]! * centerK;
        forces[ix + 2] = forces[ix + 2]! - positions[ix + 2]! * centerK;
      }

      let maxVelocity = 0;
      for (let i = 0; i < count; i += 1) {
        const ix = i * 3;
        velocities[ix] = (velocities[ix]! + forces[ix]! * dt) * damping;
        velocities[ix + 1] = (velocities[ix + 1]! + forces[ix + 1]! * dt) * damping;
        velocities[ix + 2] = (velocities[ix + 2]! + forces[ix + 2]! * dt) * damping;

        const speedSq =
          velocities[ix]! * velocities[ix]! +
          velocities[ix + 1]! * velocities[ix + 1]! +
          velocities[ix + 2]! * velocities[ix + 2]!;
        const maxSpeedSq = maxSpeed * maxSpeed;
        if (speedSq > maxSpeedSq) {
          const scale = maxSpeed / Math.sqrt(speedSq);
          velocities[ix] = velocities[ix]! * scale;
          velocities[ix + 1] = velocities[ix + 1]! * scale;
          velocities[ix + 2] = velocities[ix + 2]! * scale;
        }

        positions[ix] = positions[ix]! + velocities[ix]! * dt;
        positions[ix + 1] = positions[ix + 1]! + velocities[ix + 1]! * dt;
        positions[ix + 2] = positions[ix + 2]! + velocities[ix + 2]! * dt;
        maxVelocity = Math.max(maxVelocity, Math.sqrt(speedSq));

        nodeObjects[i]!.mesh.position.set(positions[ix]!, positions[ix + 1]!, positions[ix + 2]!);
      }

      let offset = 0;
      for (const [a, b] of edgePairs) {
        const ax = a * 3;
        const bx = b * 3;
        edgePositions[offset++] = positions[ax]!;
        edgePositions[offset++] = positions[ax + 1]!;
        edgePositions[offset++] = positions[ax + 2]!;
        edgePositions[offset++] = positions[bx]!;
        edgePositions[offset++] = positions[bx + 1]!;
        edgePositions[offset++] = positions[bx + 2]!;
      }
      (edgeGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      return maxVelocity;
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lastSelected: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null = null;

    const resetEmissive = (
      mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
    ) => {
      const owner = nodeObjects.find((n) => n.mesh === mesh);
      const isSeed = owner?.meta.isSeed ?? false;
      mesh.material.emissive.set(isSeed ? (colors?.primary ?? "#1f3b7b") : "#000000");
      mesh.material.emissiveIntensity = isSeed ? 0.22 : 0;
    };

    const handlePointerDown = (evt: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((evt.clientY - rect.top) / rect.height) * 2 - 1);
      pointer.set(x, y);
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(nodeObjects.map((n) => n.mesh), false);
      const hit = intersections[0]?.object as THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | undefined;
      if (!hit) {
        if (lastSelected) {
          resetEmissive(lastSelected);
          lastSelected = null;
          setSelectedNode(null);
          requestRender(180);
        }
        return;
      }
      const picked = nodeObjects.find((n) => n.mesh === hit);
      if (!picked) {
        return;
      }

      if (lastSelected && lastSelected !== picked.mesh) {
        resetEmissive(lastSelected);
      }
      picked.mesh.material.emissive.set(colors?.accent ?? "#f59e0b");
      picked.mesh.material.emissiveIntensity = 0.55;
      lastSelected = picked.mesh;
      setSelectedNode(picked.meta);
      requestRender(180);
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(1, dom.clientWidth);
      const nextHeight = Math.max(1, dom.clientHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
      requestRender(120);
    });
    resizeObserver.observe(dom);

    let rafId: number | null = null;
    let lastTs = performance.now();
    let running = true;
    const simulationUntilMs = lastTs + 3000;
    let stableFrames = 0;
    let simulationActive = true;
    let interactiveUntilMs = lastTs + 180;
    let renderRequested = true;

    const renderScene = () => {
      renderer.render(scene, camera);
      renderRequested = false;
    };

    const requestFrame = () => {
      if (!running || rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(animate);
    };

    function requestRender(interactionWindowMs = 0) {
      const now = performance.now();
      interactiveUntilMs = Math.max(interactiveUntilMs, now + interactionWindowMs);
      renderRequested = true;
      requestFrame();
    }

    const handleControlsActivity = () => {
      requestRender(220);
    };

    controls.addEventListener("start", handleControlsActivity);
    controls.addEventListener("change", handleControlsActivity);
    controls.addEventListener("end", handleControlsActivity);

    const animate = () => {
      rafId = null;
      if (!running) {
        return;
      }

      const now = performance.now();
      const dt = clamp((now - lastTs) / 1000, 0.006, 0.032);
      lastTs = now;

      if (simulationActive) {
        const maxVelocity = applyForces(dt);
        renderRequested = true;
        if (maxVelocity < 0.12) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        if (now >= simulationUntilMs || stableFrames >= 18) {
          simulationActive = false;
        }
      }

      const interactionActive = now < interactiveUntilMs;
      if (interactionActive) {
        controls.update();
        renderRequested = true;
      }

      if (renderRequested || simulationActive || interactionActive) {
        renderScene();
      }

      if (simulationActive || interactionActive) {
        requestFrame();
      }
    };

    requestRender(220);

    return () => {
      running = false;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      controls.removeEventListener("start", handleControlsActivity);
      controls.removeEventListener("change", handleControlsActivity);
      controls.removeEventListener("end", handleControlsActivity);
      controls.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      nodeGeometry.dispose();
      nodeObjects.forEach(({ mesh }) => {
        mesh.material.dispose();
        scene.remove(mesh);
      });
      scene.remove(edgeLines);
      renderer.dispose();
      dom.innerHTML = "";
    };
  }, [colors, degreeMap, graph, layoutNonce]);

  if (sessionStatus === "loading") {
    return (
      <div className="h-[420px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (authenticated && !canReadDashboards) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("common.accessDeniedDescription", {
            defaultValue:
              "You don't have permission to view this data. Contact an administrator if you need access."
          })}
        />
      </div>
    );
  }

  if (settingsLoading) {
    return (
      <div className="h-[420px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (settingsError) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={settingsError.message}
          actionLabel={t("dashboard.actions.retryFetch", {
            defaultValue: "Retry fetch"
          })}
          actionLoading={refreshingSettings}
          onAction={() => {
            void refreshSettings();
          }}
        />
      </div>
    );
  }

  if (isDisabledByAdmin) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="offline"
          title={t("dashboard.charts.knowledgeGraphDisabledTitle", { defaultValue: "Disabled" })}
          description={t("dashboard.charts.knowledgeGraphDisabledDescription", { defaultValue: "Disabled by admin" })}
        />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap" }}>
        <Space.Compact style={{ maxWidth: 320, width: "100%" }}>
          <Input
            value={seedDraft}
            onChange={(evt) => setSeedDraft(evt.target.value)}
            onPressEnter={(event) => handleSearch(event.currentTarget.value)}
            placeholder={t("dashboard.charts.knowledgeGraphSeedPlaceholder", { defaultValue: "Entity name" })}
            allowClear
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            aria-label={t("common.search", { defaultValue: "Search" })}
            onClick={() => handleSearch()}
          />
        </Space.Compact>
        <Button
          onClick={() => {
            setLayoutNonce((prev) => prev + 1);
            setSelectedNode(null);
          }}
          disabled={!graph}
        >
          {t("dashboard.charts.knowledgeGraphReflow", { defaultValue: "Reflow" })}
        </Button>
        <Space size="middle">
          <div>
            <Text type="secondary">
              {t("dashboard.charts.knowledgeGraphDepth", { defaultValue: "Depth" })}: {maxDepth}
            </Text>
            <Slider min={1} max={5} step={1} value={maxDepth} onChange={(value) => setMaxDepth(value)} style={{ width: 140 }} />
          </div>
          <div>
            <Text type="secondary">
              {t("dashboard.charts.knowledgeGraphMaxNodes", { defaultValue: "Max nodes" })}: {maxNodes}
            </Text>
            <Slider min={50} max={180} step={10} value={maxNodes} onChange={(value) => setMaxNodes(value)} style={{ width: 160 }} />
          </div>
        </Space>
        <Link href={explorerHref}>
          <Button>{t("pages.knowledgeGraph.actions.openExplorer", { defaultValue: "Open explorer" })}</Button>
        </Link>
      </div>

      {settings ? (
        <Space size="small" wrap style={{ marginBottom: "0.75rem" }}>
          <Tag color="blue">
            {t("settings.knowledgeGraph.fields.minEdgeConfidence")}:{" "}
            {Number(settings.minEdgeConfidence ?? 0).toFixed(2)}
          </Tag>
          {settings.dynamicEdgeConfidenceEnabled ? (
            <Tag>
              {t("settings.knowledgeGraph.fields.dynamicEdgeConfidenceEnabled")}{" "}
              Q{Number(settings.dynamicEdgeConfidenceQuantile ?? 0.25).toFixed(2)}
            </Tag>
          ) : null}
          {settings.multiModelValidationEnabled ? (
            <Tag color="green">{t("settings.knowledgeGraph.fields.multiModelValidationEnabled")}</Tag>
          ) : null}
          {settings.entityDisambiguationEnabled ? (
            <Tag color="geekblue">{t("settings.knowledgeGraph.fields.entityDisambiguationEnabled")}</Tag>
          ) : null}
        </Space>
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error.message}
          action={
            <Button
              size="small"
              loading={refreshingGraph}
              disabled={refreshingGraph}
              onClick={() => {
                void refreshGraph();
              }}
            >
              {t("dashboard.actions.retryFetch", {
                defaultValue: "Retry fetch"
              })}
            </Button>
          }
          style={{ marginBottom: "0.75rem" }}
        />
      ) : null}

      {!seedName ? (
        <div className="h-[380px]">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphEmptyTitle", { defaultValue: "No data" })}
            description={t("dashboard.charts.knowledgeGraphEmptyDescription", {
              defaultValue: "Search an entity to load real graph data"
            })}
          />
        </div>
      ) : loading ? (
        <div className="h-[380px] flex items-center">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : graph ? (
        <div className="relative">
          <div ref={containerRef} className="h-[380px] w-full" />
          {selectedNode ? (
            <div className="absolute top-2 right-2 bg-white/90 border border-slate-200 rounded-md px-3 py-2 shadow-sm">
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{selectedNode.name}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                type: {selectedNode.type} | degree: {selectedNode.degree}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="h-[380px]">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphNotFoundTitle", { defaultValue: "Not found" })}
            description={t("dashboard.charts.knowledgeGraphNotFoundDescription", {
              defaultValue: "No graph data found for this entity"
            })}
          />
        </div>
      )}
    </>
  );
}
