"use client";

import { Button, Form, Space } from "antd";
import { useTranslation } from "react-i18next";

import { RealtimeSignalsCredentialsSection } from "./realtime-signals-credentials-section";
import { RealtimeSignalsEndpointsSection } from "./realtime-signals-endpoints-section";
import { RealtimeSignalsGeneralSection } from "./realtime-signals-general-section";
import { RealtimeSignalsOpenskySection } from "./realtime-signals-opensky-section";
import { RealtimeSignalsSourcesSection } from "./realtime-signals-sources-section";
import { RealtimeSignalsThresholdsSection } from "./realtime-signals-thresholds-section";
import type {
  RealtimeSignalsFormInstance,
  RealtimeSignalsSettingsFormValues,
} from "./realtime-signals-types";

export interface RealtimeSignalsSettingsFormProps {
  form: RealtimeSignalsFormInstance;
  openskySourceName: string;
  acledApiDisabled: boolean;
  saving: boolean;
  resetting: boolean;
  onSubmit: (values: RealtimeSignalsSettingsFormValues) => void;
  onReset: () => void;
}

export function RealtimeSignalsSettingsForm({
  form,
  openskySourceName,
  acledApiDisabled,
  saving,
  resetting,
  onSubmit,
  onReset,
}: RealtimeSignalsSettingsFormProps) {
  const { t } = useTranslation();

  return (
    <Form layout="vertical" form={form} onFinish={onSubmit}>
      <RealtimeSignalsGeneralSection />
      <RealtimeSignalsSourcesSection />
      <RealtimeSignalsOpenskySection openskySourceName={openskySourceName} />
      <RealtimeSignalsThresholdsSection />
      <RealtimeSignalsEndpointsSection />
      <RealtimeSignalsCredentialsSection acledApiDisabled={acledApiDisabled} />

      <Space wrap>
        <Button
          type="primary"
          htmlType="submit"
          loading={saving}
          disabled={resetting}
        >
          {t("common.saveChanges")}
        </Button>
        <Button
          danger
          onClick={onReset}
          loading={resetting}
          disabled={saving}
        >
          {t("systemSettings.realtimeSignals.actions.reset")}
        </Button>
      </Space>
    </Form>
  );
}
