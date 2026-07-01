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
  const normalized = type.trim().toLowerCase();
  const colors: Record<string, string> = {
    company: "#2563eb",
    industry: "#16a34a",
    person: "#f97316",
    policy: "#dc2626",
    commodity: "#9333ea",
    instrument: "#0891b2",
    organization: "#64748b",
  };
  return colors[normalized] ?? "#94a3b8";
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
  } as unknown as LayoutOptions;
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
            color: "#0f172a",
            "font-size": 11,
            "font-weight": (ele: NodeSingular) =>
              ele.data("isSeed") ? 700 : 500,
            "border-width": (ele: NodeSingular) =>
              ele.data("isSeed") ? 3 : 1.5,
            "border-color": "#e2e8f0",
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
              if (confidence >= 0.85) return "#16a34a";
              if (confidence >= 0.7) return "#f59e0b";
              return "#ef4444";
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
            "border-color": "#0f172a",
            "border-width": 4,
            "overlay-opacity": 0.08,
            "overlay-color": "#1d4ed8",
          },
        },
        {
          selector: "edge:selected",
          style: {
            width: 6,
            "overlay-opacity": 0.06,
            "overlay-color": "#0f172a",
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
  }, [elements, onClearSelection, onEdgeSelect, onNodeSelect]);

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
      className="min-h-[640px] rounded-[28px] border border-slate-200/80 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.09),_transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.98))]"
      data-mobile={isMobile ? "true" : "false"}
    />
  );
}
