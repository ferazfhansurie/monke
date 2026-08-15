"use client";

import { Download, User } from "lucide-react";
import { useMonkeStore } from "@/lib/store";

export function TopBar() {
  const projectName = useMonkeStore((s) => s.projectName);

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 bg-[#0d1117] px-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold tracking-tight text-white">MONKe</span>
        <span className="text-[11px] text-gray-600">{projectName}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md bg-[#f26522] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#d9541a] transition-colors"
        >
          <Download className="h-3 w-3" /> Export
        </button>
        <button type="button" className="rounded-full p-1 text-gray-400 hover:bg-white/10 hover:text-white">
          <User className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
