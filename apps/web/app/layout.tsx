import type { ReactNode } from "react";
import { Inter, Playfair_Display } from "next/font/google";

import { auth } from "@/lib/auth";
import { ThemeProvider } from "@/hooks/use-theme";

import "./globals.css";
import { AppProviders } from "./providers";
import { SessionProviders } from "./session-provider";

export const metadata = {
  title: "Modular Admin",
  description: "Operator dashboard"
};

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-serif" });

const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var key='theme';var root=document.documentElement;var stored=window.localStorage.getItem(key);var theme=(stored==='light'||stored==='dark')?stored:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');root.classList.toggle('dark',theme==='dark');root.style.colorScheme=theme;}catch(_){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body className={`${inter.variable} ${playfair.variable} font-sans bg-background text-foreground antialiased`}>
        <ThemeProvider>
          <SessionProviders session={session}>
            <AppProviders>{children}</AppProviders>
          </SessionProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
