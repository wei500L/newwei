"use client";

import cytoscape, {
  type Core,
  type EdgeSingular,
  type ElementDefinition,
  type LayoutOptions,
  type NodeSingular,
} from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useRef } from "react";

import { useTheme } from "@/hooks/use-theme";
import {
  DEFAULT_NODE_COLOR,
  KNOWLEDGE_GRAPH_LABEL_COLORS,
  KNOWLEDGE_GRAPH_NODE_COLORS,
} from "@/lib/graph-tokens";

const FCOSE_RUNTIME_KEY = "__modular_knowledge_graph_fcose_registered__";

export type KnowledgeGraphCanvasElement = ElementDefinition;

export interface KnowledgeGraphCanvasProps {
  elements: KnowledgeGraphCanvasElement[];
  isMobile: boolean;
  layoutRunNonce: number;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNodeSelect: (id: string) => void;
  onEdgeSelect: (id: string) => void;
  onClearSelection: () => void;
}

function ensureFcoseRegistered() {
  const target = globalThis as typeof globalThis & {
    [FCOSE_RUNTIME_KEY]?: boolean;
  };
  if (target[FCOSE_RUNTIME_KEY]) {
    return;
  }
  cytoscape.use(fcose);
  target[FCOSE_RUNTIME_KEY] = true;
}

function getNodeColor(type: string) {
  const normalized = type
    .trim()
    .toLowerCase() as keyof typeof KNOWLEDGE_GRAPH_NODE_COLORS;
  return KNOWLEDGE_GRAPH_NODE_COLORS[normalized] ?? DEFAULT_NODE_COLOR;
}

function createFcoseLayoutOptions(animate: boolean): LayoutOptions {
  return {
    name: "fcose",
    animate,
    fit: true,
    padding: 32,
    nodeRepulsion: 8_000,
    idealEdgeLength: 140,
    edgeElasticity: 0.08,
    gravity: 0.18,
    quality: "proof",
  } as LayoutOptions;
}

function runFcoseLayout(cy: Core, animate: boolean) {
  cy.layout(createFcoseLayoutOptions(animate)).run();
}

export function KnowledgeGraphCanvas({
  elements,
  isMobile,
  layoutRunNonce,
  selectedNodeId,
  selectedEdgeId,
  onNodeSelect,
  onEdgeSelect,
  onClearSelection,
}: KnowledgeGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const { isDark } = useTheme();

  useEffect(() => {
    ensureFcoseRegistered();
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    ensureFcoseRegistered();
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      layout: createFcoseLayoutOptions(false),
      wheelSensitivity: 0.18,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele: NodeSingular) =>
              getNodeColor(String(ele.data("type") ?? "")),
            label: "data(label)",
            color: isDark
              ? KNOWLEDGE_GRAPH_LABEL_COLORS.dark
              : KNOWLEDGE_GRAPH_LABEL_COLORS.light,
            "font-size": 11,
            "font-weight": (ele: NodeSingular) =>
              ele.data("isSeed") ? 700 : 500,
            "border-width": (ele: NodeSingular) =>
              ele.data("isSeed") ? 3 : 1.5,
            "border-color": isDark ? "#3a414d" : "#faf8f3",
            width: (ele: NodeSingular) =>
              Math.max(28, Math.min(68, 28 + Number(ele.data("degree") ?? 0) * 5)),
            height: (ele: NodeSingular) =>
              Math.max(28, Math.min(68, 28 + Number(ele.data("degree") ?? 0) * 5)),
            "text-wrap": "wrap",
            "text-max-width": "110px",
            "text-valign": "bottom",
            "text-margin-y": 10,
          },
        },
        {
          selector: "edge",
          style: {
            width: (ele: EdgeSingular) =>
              Math.max(1.5, Math.min(6, Number(ele.data("weight") ?? 1))),
            "line-color": (ele: EdgeSingular) => {
              const confidence = Number(ele.data("confidence") ?? 0);
              if (confidence >= 0.85) return "#2f7d5b";
              if (confidence >= 0.7) return "#b45309";
              return "#b91c1c";
            },
            opacity: (ele: EdgeSingular) =>
              Math.max(0.3, Math.min(0.92, Number(ele.data("confidence") ?? 0.5))),
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "line-color",
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-color": isDark ? "#e8e4da" : "#161b26",
            "border-width": 4,
            "overlay-opacity": 0.08,
            "overlay-color": "#1f3b7b",
          },
        },
        {
          selector: "edge:selected",
          style: {
            width: 6,
            "overlay-opacity": 0.06,
            "overlay-color": "#161b26",
          },
        },
      ],
    });

    cy.on("tap", "node", (event) => {
      onNodeSelect(String(event.target.id()));
    });

    cy.on("tap", "edge", (event) => {
      onEdgeSelect(String(event.target.id()));
    });

    cy.on("tap", (event) => {
      if (event.target === cy) {
        onClearSelection();
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements, isDark, onClearSelection, onEdgeSelect, onNodeSelect]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.elements().unselect();
    if (selectedNodeId) {
      cy.$id(selectedNodeId).select();
    }
    if (selectedEdgeId) {
      cy.$id(selectedEdgeId).select();
    }
  }, [selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || layoutRunNonce <= 0) {
      return;
    }
    runFcoseLayout(cy, true);
  }, [layoutRunNonce]);

  return (
    <div
      ref={containerRef}
      className="min-h-[min(640px,70dvh)] rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]"
      data-mobile={isMobile ? "true" : "false"}
    />
  );
}
