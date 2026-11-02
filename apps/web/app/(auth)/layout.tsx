import type { ReactNode } from "react";

import { LanguageSwitcher } from "@/app/(app)/components/language-switcher";

import { AuthMasthead } from "./auth-masthead";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-layout">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher compact />
      </div>
      <div className="flex w-full flex-col items-center gap-6">
        <AuthMasthead />
        {children}
      </div>
    </div>
  );
}
