"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, User, LogOut } from "lucide-react";
import { useMonkeStore } from "@/lib/store";

export function TopBar() {
  const router = useRouter();
  const projectName = useMonkeStore((s) => s.projectName);
  const user = useMonkeStore((s) => s.user);
  const [menuOpen, setMenuOpen] = useState(false);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

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
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-full p-1 text-gray-400 hover:bg-white/10 hover:text-white"
            title={user?.email}
          >
            <User className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-white/10 bg-[#161b22] py-1 shadow-lg">
              <div className="truncate border-b border-white/10 px-3 py-1.5 text-[11px] text-gray-400">{user?.email}</div>
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/5"
              >
                <LogOut className="h-3 w-3" /> Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
