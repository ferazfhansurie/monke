"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EditorStage } from "@/components/editor-stage";
import { useMonkeStore, hydrateMonkeStore } from "@/lib/store";

export default function Home() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const setUser = useMonkeStore((s) => s.setUser);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(async (data) => {
        if (!data.user) {
          router.replace("/login");
          return;
        }
        setUser(data.user);
        const billing = await fetch("/api/billing/status").then((r) => r.json());
        if (!billing.subscriptionActive) {
          router.replace("/pricing");
          return;
        }
        await hydrateMonkeStore();
        setReady(true);
      })
      .catch(() => router.replace("/login"));
  }, [router, setUser]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0c10]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-600" />
      </div>
    );
  }

  return <EditorStage />;
}
