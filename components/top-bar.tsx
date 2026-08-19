"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Download, User, LogOut, CreditCard, Coins, Shield } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { isAdminEmail } from "@/lib/admin";
import { exportTimeline, isExportSupported, type ExportProgress } from "@/lib/export";
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

  // Export runs entirely in this tab (WebCodecs -> mp4-muxer), so it has to
  // be cancellable and show real progress — a 30s 1080x1920 render is
  // minutes of work, not a spinner.
  const [exporting, setExporting] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const runExport = async () => {
    setExportError(null);
    const support = await isExportSupported();
    if (!support.ok) {
      setExportError(support.reason ?? "Export isn't available in this browser.");
      return;
    }
    const store = useMonkeStore.getState();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting({ phase: "preparing", progress: null, message: "Preparing…" });
    try {
      const blob = await exportTimeline({
        timeline: store.timeline,
        items: store.items,
        settings: store.settings,
        cutoutFrames: store.cutoutFrames,
        signal: controller.signal,
        onProgress: setExporting,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${store.projectName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "monke"}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      if (msg !== "Export cancelled") setExportError(msg);
    } finally {
      exportAbortRef.current = null;
      setExporting(null);
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
        {exportError && (
          <span
            className="max-w-[260px] truncate rounded-md bg-red-500/10 px-2 py-1 text-[10px] text-red-300"
            title={exportError}
            onClick={() => setExportError(null)}
            role="alert"
          >
            {exportError}
          </span>
        )}
        {exporting ? (
          <div className="flex items-center gap-2 rounded-md bg-white/5 px-2.5 py-1">
            <span className="text-[10px] text-gray-400">
              {exporting.progress != null ? `${Math.round(exporting.progress * 100)}%` : exporting.message}
            </span>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full bg-[#f26522] transition-[width]"
                style={{ width: `${(exporting.progress ?? 0) * 100}%` }}
              />
            </span>
            <button
              type="button"
              onClick={() => exportAbortRef.current?.abort()}
              className="text-[10px] font-semibold text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={runExport}
            title="Render the timeline to an MP4"
            className="flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Download className="h-3 w-3" /> Export
          </button>
        )}
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
