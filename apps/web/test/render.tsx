import { render, type RenderOptions } from "@testing-library/react";
import { ConfigProvider } from "antd";
import type { ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

import { initI18n } from "@/lib/i18n-client";

const i18n = initI18n();

function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ConfigProvider>{children}</ConfigProvider>
    </I18nextProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: Providers, ...options });
}

export { i18n };
