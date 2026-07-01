import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/hooks/use-theme";
import { auth } from "@/lib/auth";
import { LANGUAGE_COOKIE_KEY, resolveLocale } from "@/lib/i18n";

import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { AppProviders } from "./providers";
import { SessionProviders } from "./session-provider";

export const metadata = {
  title: "Modular Admin",
  description: "Operator dashboard",
};

const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var key='theme';var root=document.documentElement;var stored=window.localStorage.getItem(key);var theme=(stored==='light'||stored==='dark')?stored:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');root.classList.toggle('dark',theme==='dark');root.style.colorScheme=theme;}catch(_){}})();`;

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const [session, cookieStore] = await Promise.all([auth(), cookies()]);
  const htmlLang = resolveLocale(cookieStore.get(LANGUAGE_COOKIE_KEY)?.value);
  return (
    <html lang={htmlLang} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="font-sans bg-background text-foreground antialiased">
        <ThemeProvider>
          <SessionProviders session={session}>
            <AppProviders>{children}</AppProviders>
          </SessionProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
