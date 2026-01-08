"use client";

import { message } from "antd";
import type { PropsWithChildren } from "react";

import { ActionRail } from "./action-rail";
import { TopNav } from "./top-nav";

export function ShellLayout({ children }: PropsWithChildren) {
  const [, contextHolder] = message.useMessage();
  
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {contextHolder}

      <TopNav />

      <div className="flex flex-1 overflow-hidden pt-24 relative">
        <ActionRail />
        
        <main className="flex-1 overflow-auto scrollbar-thin scrollbar-thumb-slate-200/80 hover:scrollbar-thumb-slate-300/90 scrollbar-track-transparent">
          <div className="w-full max-w-[1440px] mx-auto p-4 md:p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
