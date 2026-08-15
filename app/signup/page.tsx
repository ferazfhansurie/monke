"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Signup failed");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0c10] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white">MONKe</h1>
          <p className="mt-1 text-[13px] text-gray-500">Create your account</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-white outline-none focus:border-[#f26522]/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-white outline-none focus:border-[#f26522]/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-white outline-none focus:border-[#f26522]/50"
            />
            <p className="mt-1 text-[10px] text-gray-600">At least 8 characters</p>
          </div>
          {error && <p className="text-[12px] text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="mt-1 flex items-center justify-center gap-1.5 rounded-md bg-[#f26522] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[#d9541a] disabled:opacity-50 transition-colors"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign up
          </button>
        </form>
        <p className="mt-4 text-center text-[12px] text-gray-500">
          Already have an account?{" "}
          <Link href="/login" className="text-[#f26522] hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
