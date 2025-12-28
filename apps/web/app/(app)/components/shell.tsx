"use client";

import { Layout, message, theme } from "antd";
import type { PropsWithChildren } from "react";
import { TopNav } from "./top-nav";
import { ActionRail } from "./action-rail";

export function ShellLayout({ children }: PropsWithChildren) {
  const [messageApi, contextHolder] = message.useMessage();
  
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {contextHolder}
      
      {/* Top Navigation - HUD Style */}
      <TopNav />

      {/* Main Layout: Rail + Content */}
      <div className="flex flex-1 overflow-hidden pt-24 relative">
        <ActionRail />
        
        {/* Main Content Area - Transparent for map visibility */}
        <main className="flex-1 overflow-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent z-10">
           <div className="w-full max-w-[1920px] mx-auto p-4 md:p-6">
              {children}
           </div>
        </main>
      </div>
    </div>
  );
}
