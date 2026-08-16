"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Download, User, LogOut, CreditCard, Coins, Shield } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { isAdminEmail } from "@/lib/admin";
import { ProjectSwitcher } from "./project-switcher";

export function TopBar() {
  const router = useRouter();
  const user = useMonkeStore((s) => s.user);
  const [menuOpen, setMenuOpen] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [creditInput, setCreditInput] = useState("");
  const [settingCredits, setSettingCredits] = useState(false);

  const refreshCredits = () => {
    fetch("/api/billing/status")
      .then((r) => r.json())
      .then((data) => setCredits(typeof data.credits === "number" ? data.credits : null))
      .catch(() => {});
  };

  useEffect(() => {
    refreshCredits();
  }, []);

  const isAdmin = !!user?.email && isAdminEmail(user.email);

  const setAdminCredits = async () => {
    const value = Number(creditInput);
    if (!Number.isFinite(value)) return;
    setSettingCredits(true);
    try {
      const res = await fetch("/api/billing/admin/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credits: value }),
      });
      const data = await res.json();
      if (res.ok) setCredits(data.credits);
    } finally {
      setSettingCredits(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  const manageBilling = async () => {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.url) window.location.assign(data.url);
    } finally {
      setPortalLoading(false);
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 bg-[#0d1117] px-3">
      <div className="flex items-center gap-2">
        <Image src="/logo-white.png" alt="MONKe" width={168} height={115} className="h-7 w-auto" priority />
        <span className="text-gray-700">/</span>
        <ProjectSwitcher />
      </div>
      <div className="flex items-center gap-2">
        {credits != null && (
          <span className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] font-semibold text-gray-400" title="Credit balance">
            <Coins className="h-3 w-3 text-[#f26522]" /> {credits.toLocaleString()}
          </span>
        )}
        <button
          type="button"
          disabled
          title="Export isn't built yet"
          className="flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-gray-600 cursor-not-allowed"
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
                onClick={manageBilling}
                disabled={portalLoading}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/5 disabled:opacity-50"
              >
                <CreditCard className="h-3 w-3" /> Manage billing
              </button>
              {isAdmin && (
                <div className="border-t border-white/10 px-3 py-1.5">
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-gray-500">
                    <Shield className="h-3 w-3" /> Admin: set credits
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={creditInput}
                      onChange={(e) => setCreditInput(e.target.value)}
                      placeholder={String(credits ?? 0)}
                      className="w-full rounded bg-white/5 px-1.5 py-1 text-[11px] text-gray-200 outline-none"
                    />
                    <button
                      type="button"
                      onClick={setAdminCredits}
                      disabled={settingCredits || !creditInput}
                      className="shrink-0 rounded bg-[#f26522] px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                    >
                      Set
                    </button>
                  </div>
                </div>
              )}
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
