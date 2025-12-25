"use client";

import { AppstoreOutlined, BarsOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Segmented } from "antd";
import { useTranslation } from "react-i18next";

export type ItemViewType = "list" | "grid" | "feed";

interface ViewSwitcherProps {
  view: ItemViewType;
  onChange: (view: ItemViewType) => void;
}

export function ViewSwitcher({ view, onChange }: ViewSwitcherProps) {
  const { t } = useTranslation();

  return (
    <Segmented
      value={view}
      onChange={(value) => onChange(value as ItemViewType)}
      options={[
        {
          value: "list",
          icon: <UnorderedListOutlined />,
          label: t("items.view.list", { defaultValue: "List" }),
        },
        {
          value: "grid",
          icon: <AppstoreOutlined />,
          label: t("items.view.grid", { defaultValue: "Grid" }),
        },
        {
          value: "feed",
          icon: <BarsOutlined />,
          label: t("items.view.feed", { defaultValue: "Feed" }),
        },
      ]}
    />
  );
}
