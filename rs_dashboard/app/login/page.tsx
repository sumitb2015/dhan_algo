"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Activity, AlertCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingPaths } from "@/components/ui/background-paths";

// ─── Login page ───────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();

  const [clientId,    setClientId]    = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [remember,    setRemember]    = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [apiError,    setApiError]    = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ clientId?: string; accessToken?: string }>({});

  function validate(): boolean {
    const errors: { clientId?: string; accessToken?: string } = {};
    if (!clientId.trim())       errors.clientId    = "Required";
    if (!accessToken.trim())    errors.accessToken = "Required";
    else if (accessToken.trim().length < 10) errors.accessToken = "Token appears too short";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    if (!validate()) return;
    setLoading(true);
    try {
      const res  = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId.trim(), access_token: accessToken.trim(), remember }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setApiError(data.error ?? "Authentication failed. Please check your credentials.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setApiError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-950 flex items-center justify-center px-4">

      {/* Layer 1 — animated floating paths */}
      <div className="absolute inset-0 opacity-50">
        <FloatingPaths position={1} />
        <FloatingPaths position={-1} />
      </div>

      {/* Layer 2 — emerald bloom from below */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 75% 45% at 50% 115%, rgba(52,211,153,0.07) 0%, transparent 100%)",
        }}
        aria-hidden="true"
      />

      {/* Layer 3 — card */}
      <Card className="relative z-10 w-full max-w-md border-zinc-800 bg-zinc-900/80 shadow-2xl backdrop-blur-xl">

        <CardHeader className="space-y-1 pb-2">
          {/* Eyebrow */}
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            Dhan · Algo
          </p>
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-emerald-400" />
            <CardTitle className="text-base font-semibold">Connect to Dhan</CardTitle>
          </div>
          <CardDescription>
            Enter your Client ID and Access Token from the{" "}
            <span className="font-medium text-zinc-300">Dhan portal</span> to continue.
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">

            {/* API error banner */}
            {apiError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{apiError}</span>
              </div>
            )}

            {/* Client ID */}
            <div className="space-y-1.5">
              <Label htmlFor="clientId">Client ID</Label>
              <Input
                id="clientId"
                type="text"
                placeholder="e.g. 10XXXXX"
                value={clientId}
                onChange={e => { setClientId(e.target.value); setFieldErrors(p => ({ ...p, clientId: undefined })); }}
                disabled={loading}
                aria-invalid={!!fieldErrors.clientId}
                autoComplete="username"
                autoFocus
              />
              {fieldErrors.clientId && (
                <p className="text-xs text-red-400">{fieldErrors.clientId}</p>
              )}
            </div>

            {/* Access Token */}
            <div className="space-y-1.5">
              <Label htmlFor="accessToken">Access Token</Label>
              <Input
                id="accessToken"
                type="password"
                placeholder="Paste your access token"
                value={accessToken}
                onChange={e => { setAccessToken(e.target.value); setFieldErrors(p => ({ ...p, accessToken: undefined })); }}
                disabled={loading}
                aria-invalid={!!fieldErrors.accessToken}
                className="font-mono tracking-wider"
                autoComplete="current-password"
              />
              {fieldErrors.accessToken && (
                <p className="text-xs text-red-400">{fieldErrors.accessToken}</p>
              )}
            </div>

            {/* Remember session */}
            <div className="flex items-center gap-2.5 pt-1">
              <Checkbox
                id="remember"
                checked={remember}
                onCheckedChange={(checked) => setRemember(Boolean(checked))}
                disabled={loading}
              />
              <Label htmlFor="remember" className="cursor-pointer text-zinc-400">
                Remember this session{" "}
                <span className="text-xs text-zinc-600">(24 h)</span>
              </Label>
            </div>
          </CardContent>

          <CardFooter>
            <Button
              type="submit"
              size="lg"
              className="h-9 w-full"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                "Connect"
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
