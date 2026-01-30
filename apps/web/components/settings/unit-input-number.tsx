"use client";

import { InputNumber, Space } from "antd";
import type { InputNumberProps } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface UnitInputNumberProps
  extends Omit<InputNumberProps<number>, "addonAfter" | "addonBefore"> {
  unit: ReactNode;
  style?: CSSProperties;
  inputStyle?: CSSProperties;
}

export function UnitInputNumber({
  unit,
  style,
  inputStyle,
  ...props
}: UnitInputNumberProps) {
  return (
    <Space.Compact style={style}>
      <InputNumber {...props} style={{ width: "100%", ...inputStyle }} />
      <span className="ant-input-group-addon">{unit}</span>
    </Space.Compact>
  );
}

