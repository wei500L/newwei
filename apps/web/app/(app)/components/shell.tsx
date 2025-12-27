"use client";

import { Layout, message, theme } from "antd";
import type { PropsWithChildren } from "react";
import { TopNav } from "./top-nav";
import { ActionRail } from "./action-rail";

export function ShellLayout({ children }: PropsWithChildren) {
  const [messageApi, contextHolder] = message.useMessage();
  
  return (
    <div className="flex flex-col h-screen bg-[var(--background)] overflow-hidden">
      {contextHolder}
      
      {/* Top Navigation */}
      <TopNav />

      {/* Main Layout: Rail + Content */}
      <div className="flex flex-1 overflow-hidden pt-16">
        <ActionRail />
        
        {/* Main Content Area */}
        <main className="flex-1 overflow-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
           <div className="w-full max-w-[1800px] mx-auto p-6">
              {children}
           </div>
        </main>
      </div>
    </div>
  );
}
