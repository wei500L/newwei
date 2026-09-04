"use client";

import { useEffect, useState } from "react";

import {
  useAlertEventReplayLazyQuery,
  type AlertEventReplayQuery,
} from "@/graphql/generated";

import type { AlertEventItem } from "../alert-center.utils";
import { readFeedbackPresetNote } from "../alert-event-detail-model";

/**
 * Alert Center 详情域数据 hook（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - replay 懒加载门禁：仅在选中 replay 页签且存在事件时请求
 *   （eventId 不匹配当前事件时重新加载）；
 * - feedback note 预填：从事件 context.feedback.note 读取，事件清空时置空；
 * - detailTab / expand 状态：selectedEventId 变化时重置（既有行为）。
 */

type ReplayModel = NonNullable<AlertEventReplayQuery["alertEventReplay"]>;

export interface UseAlertEventDetailOptions {
  selectedEvent: AlertEventItem | null;
  selectedEventId: string | null;
}

export interface UseAlertEventDetailResult {
  loadReplay: ReturnType<typeof useAlertEventReplayLazyQuery>[0];
  replay: ReplayModel | null;
  replayPoints: ReplayModel["points"];
  replayUnit: string | null | undefined;
  replayLoading: boolean;
  replayError: Error | undefined;
  detailTab: string;
  setDetailTab: (tab: string) => void;
  expandMessage: boolean;
  toggleExpandMessage: () => void;
  expandContext: boolean;
  toggleExpandContext: () => void;
  feedbackNote: string;
  setFeedbackNote: (note: string) => void;
}

export function useAlertEventDetail({
  selectedEvent,
  selectedEventId,
}: UseAlertEventDetailOptions): UseAlertEventDetailResult {
  const [
    loadReplay,
    { data: replayData, loading: replayLoading, error: replayError },
  ] = useAlertEventReplayLazyQuery();

  const [detailTab, setDetailTab] = useState<string>("overview");
  const [expandMessage, setExpandMessage] = useState<boolean>(false);
  const [expandContext, setExpandContext] = useState<boolean>(false);
  const [feedbackNote, setFeedbackNote] = useState<string>("");

  // replay 懒加载：只在 replay 页签 + 存在事件时请求；切换事件后重新加载
  useEffect(() => {
    if (detailTab !== "replay" || !selectedEvent) {
      return;
    }
    if (replayData?.alertEventReplay?.eventId === selectedEvent.id) {
      return;
    }
    loadReplay({
      variables: {
        eventId: selectedEvent.id,
        windowDays: 30,
      },
    });
  }, [
    detailTab,
    loadReplay,
    replayData?.alertEventReplay?.eventId,
    selectedEvent,
  ]);

  const replay =
    replayData?.alertEventReplay &&
    replayData.alertEventReplay.eventId === selectedEvent?.id
      ? replayData.alertEventReplay
      : null;
  const replayPoints = replay?.points;
  const replayUnit = replay?.unit;

  // feedback note 预填（事件 context.feedback.note）
  useEffect(() => {
    setFeedbackNote(readFeedbackPresetNote(selectedEvent));
  }, [selectedEvent]);

  // 事件切换时重置详情视图状态
  useEffect(() => {
    setDetailTab("overview");
    setExpandContext(false);
    setExpandMessage(false);
  }, [selectedEventId]);

  return {
    loadReplay,
    replay,
    replayPoints,
    replayUnit,
    replayLoading,
    replayError,
    detailTab,
    setDetailTab,
    expandMessage,
    toggleExpandMessage: () => setExpandMessage((prev) => !prev),
    expandContext,
    toggleExpandContext: () => setExpandContext((prev) => !prev),
    feedbackNote,
    setFeedbackNote,
  };
}
