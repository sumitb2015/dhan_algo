"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Activity, AlertCircle, Settings, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { FloatingPaths } from "@/components/ui/background-paths";

// ─── Types ──────────────────────────────────────────────────────────────────

type AccountTarget = "dhan" | "both";

// Dhan is the primary account and is ALWAYS logged in — it is the only broker
// that grants the dashboard session (see the autologin route's enterDashboard),
// so it is deliberately not toggleable. These are the optional extras.
const EXTRA_BROKERS = ["zerodha", "kotak"] as const;
type ExtraBroker = typeof EXTRA_BROKERS[number];
const EXTRA_BROKER_LABELS: Record<ExtraBroker, string> = {
  zerodha: "Zerodha",
  kotak: "Kotak",
};
type BrokerResult = { success: boolean; error?: string };
type AutologinResponse = { enterDashboard: boolean; dhan?: BrokerResult; zerodha?: BrokerResult; kotak?: BrokerResult };

type FieldStatus = { set: boolean; masked?: string; value?: string };
type AuthConfig = {
  dhan: Record<string, FieldStatus>;
  zerodha: Record<string, FieldStatus>;
  kotak?: Record<string, FieldStatus>;
  /** True when the response actually carries plaintext values. */
  revealed?: boolean;
  /** False when there is no dashboard session, so reveal was refused. */
  canReveal?: boolean;
};

const DHAN_FIELD_LABELS: Record<string, string> = {
  client_id: "Client ID",
  api_key: "API Key",
  api_secret: "API Secret",
  dhan_pin: "PIN",
  totp_key: "TOTP Key",
};

const ZERODHA_FIELD_LABELS: Record<string, string> = {
  ZERODHA_USER_ID: "User ID",
  ZERODHA_API_KEY: "API Key",
  ZERODHA_API_SECRET: "API Secret",
  ZERODHA_PASSWORD: "Password",
  ZERODHA_TOTP_KEY: "TOTP Key",
};

const KOTAK_FIELD_LABELS: Record<string, string> = {
  KOTAK_UCC: "UCC",
  KOTAK_MOBILE_NUMBER: "Mobile",
  KOTAK_CONSUMER_KEY: "Consumer Key",
  KOTAK_MPIN: "MPIN",
  KOTAK_TOTP_SECRET: "TOTP Secret",
};

// ─── Settings panel ─────────────────────────────────────────────────────────

function ConfigRow({ label, status }: { label: string; status: FieldStatus }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!status.value) return;
    try {
      await navigator.clipboard.writeText(status.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked (non-HTTPS origin, or denied) — the value is on
         screen anyway, so this is not worth surfacing as an error */
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-zinc-800/60 last:border-0">
      <span className="text-sm text-zinc-400 shrink-0">{label}</span>
      {!status.set ? (
        <span className="text-xs text-zinc-600">Not configured</span>
      ) : status.value !== undefined ? (
        <button
          type="button"
          onClick={copy}
          title="Click to copy"
          className="font-mono text-xs text-zinc-200 break-all text-right hover:text-sky-300 transition-colors cursor-pointer"
        >
          {copied ? "copied!" : status.value}
        </button>
      ) : (
        <span className="font-mono text-xs text-zinc-300">{status.masked ?? "●●●●●● (set)"}</span>
      )}
    </div>
  );
}

function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Always starts hidden, even across re-opens of the sheet: secrets should not
  // reappear on screen just because they were shown once.
  const [reveal, setReveal] = useState(false);

  async function load(withValues: boolean) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/config${withValues ? "?reveal=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load configuration");
      setConfig(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load configuration");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load(reveal);
    else setReveal(false);   // re-hide when the sheet closes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reveal]);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent side="right" className="w-[380px] max-w-[100vw] bg-zinc-950 border-l border-zinc-800">
        <SheetHeader>
          <SheetTitle className="text-white">Broker configuration</SheetTitle>
          <SheetDescription>Read-only view of the values loaded from .env / .env.zerodha / .env.kotak</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
            <Checkbox
              id="reveal-secrets"
              checked={reveal}
              onCheckedChange={(checked) => setReveal(Boolean(checked))}
            />
            Show values
          </label>
          {reveal && config?.canReveal === false && (
            <p className="mt-1.5 text-xs text-amber-400">
              Sign in first — values are only returned to an authenticated session.
              This endpoint is reachable without a login, and the server listens on
              your whole network, so it will not hand out passwords or TOTP seeds
              to an unauthenticated request.
            </p>
          )}
          {reveal && config?.revealed && (
            <p className="mt-1.5 text-xs text-zinc-500">
              Showing plaintext secrets — click any value to copy it.
            </p>
          )}
        </div>

        <div className="px-4 pb-4 space-y-6 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {config && (
            <>
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-400">Dhan</p>
                {Object.entries(config.dhan).map(([key, status]) => (
                  <ConfigRow key={key} label={DHAN_FIELD_LABELS[key] ?? key} status={status} />
                ))}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-orange-400">Zerodha</p>
                {Object.entries(config.zerodha).map(([key, status]) => (
                  <ConfigRow key={key} label={ZERODHA_FIELD_LABELS[key] ?? key} status={status} />
                ))}
              </div>
              {config.kotak && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-sky-400">Kotak</p>
                  {Object.entries(config.kotak).map(([key, status]) => (
                    <ConfigRow key={key} label={KOTAK_FIELD_LABELS[key] ?? key} status={status} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Broker status chip ─────────────────────────────────────────────────────

function BrokerChip({ name, result }: { name: string; result?: BrokerResult }) {
  if (!result) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {result.success ? (
        <CheckCircle2 className="size-3.5 text-emerald-400" />
      ) : (
        <XCircle className="size-3.5 text-red-400" />
      )}
      <span className={result.success ? "text-emerald-400" : "text-red-400"}>
        {name} {result.success ? "connected" : (result.error ?? "failed")}
      </span>
    </div>
  );
}

// ─── Login page ───────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [target, setTarget] = useState<AccountTarget>("dhan");
  // Which optional brokers "All Brokers" will actually log in. Both start on so
  // the button keeps its previous one-click behaviour, but either can be
  // dropped — useful when a broker's credentials are stale, or when you simply
  // do not want to open a session on that account right now.
  const [extras, setExtras] = useState<Record<ExtraBroker, boolean>>({ zerodha: true, kotak: true });

  const [autologinLoading, setAutologinLoading] = useState(false);
  const [autologinResult, setAutologinResult] = useState<AutologinResponse | null>(null);
  const [autologinError, setAutologinError] = useState<string | null>(null);

  const [showManualForm, setShowManualForm] = useState(false);

  const [clientId,    setClientId]    = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [remember,    setRemember]    = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [apiError,    setApiError]    = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ clientId?: string; accessToken?: string }>({});

  async function handleAutologin() {
    setAutologinLoading(true);
    setAutologinError(null);
    setAutologinResult(null);
    try {
      // Dhan is always included; "both" adds only the ticked extras.
      const targets = target === "both"
        ? ["dhan", ...EXTRA_BROKERS.filter(b => extras[b])]
        : ["dhan"];
      const res = await fetch("/api/auth/autologin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets, remember }),
      });
      const data: AutologinResponse & { error?: string } = await res.json();
      if (!res.ok) {
        setAutologinError(data.error ?? "Autologin failed.");
        return;
      }
      setAutologinResult(data);
      if (data.enterDashboard) {
        router.push("/");
        router.refresh();
        return;
      }
      const connected = [
        data.zerodha?.success ? "Zerodha" : null,
        data.kotak?.success ? "Kotak" : null,
      ].filter(Boolean);
      if (connected.length && !data.dhan) {
        setAutologinError(`${connected.join(" and ")} connected — Dhan login is still required to enter the dashboard.`);
      } else if (data.dhan && !data.dhan.success) {
        setAutologinError(data.dhan.error ?? "Dhan autologin failed.");
      } else {
        setAutologinError("Autologin did not complete. See status below.");
      }
    } catch {
      setAutologinError("Network error — could not reach the server.");
    } finally {
      setAutologinLoading(false);
    }
  }

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
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              Dhan · Algo
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setSettingsOpen(true)}
              className="text-zinc-500 hover:text-white"
              aria-label="Broker configuration"
            >
              <Settings className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-emerald-400" />
            <CardTitle className="text-base font-semibold">Connect to Dhan</CardTitle>
          </div>
          <CardDescription>
            Autologin using the credentials configured in your environment, or connect manually below.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Autologin error banner */}
          {autologinError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{autologinError}</span>
            </div>
          )}

          {/* Account selector */}
          <div className="space-y-1.5">
            <Label>Account</Label>
            <ToggleGroup
              value={[target]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as AccountTarget | undefined;
                if (next) setTarget(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
              className="w-full"
            >
              <ToggleGroupItem value="dhan" className="flex-1 aria-pressed:bg-emerald-500/15 aria-pressed:text-emerald-400">
                Dhan only
              </ToggleGroupItem>
              <ToggleGroupItem value="both" className="flex-1 aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">
                All Brokers
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Which extra brokers "All Brokers" actually signs in. Dhan is shown
              as a fixed chip rather than a checkbox because it is not optional —
              it is the account that grants the dashboard session. */}
          {target === "both" && (
            <div className="space-y-1.5">
              <Label>Sign in to</Label>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
                <span
                  className="flex items-center gap-1.5 text-sm text-emerald-400"
                  title="Dhan is the primary account and always signs in — it is what grants the dashboard session."
                >
                  <CheckCircle2 className="size-3.5" />
                  Dhan
                  <span className="text-xs text-zinc-500">(always)</span>
                </span>

                {EXTRA_BROKERS.map((b) => (
                  <label key={b} className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
                    <Checkbox
                      id={`extra-${b}`}
                      checked={extras[b]}
                      onCheckedChange={(checked) =>
                        setExtras((prev) => ({ ...prev, [b]: Boolean(checked) }))
                      }
                    />
                    {EXTRA_BROKER_LABELS[b]}
                  </label>
                ))}
              </div>
              {!EXTRA_BROKERS.some((b) => extras[b]) && (
                <p className="text-xs text-zinc-500">
                  No extra brokers selected — this will sign in to Dhan only.
                </p>
              )}
            </div>
          )}

          <Button
            type="button"
            size="lg"
            className="h-9 w-full"
            disabled={autologinLoading}
            onClick={handleAutologin}
          >
            {autologinLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Authenticating…
              </>
            ) : (
              "Autologin"
            )}
          </Button>

          {autologinResult && (
            <div className="flex flex-col gap-1 pt-1">
              <BrokerChip name="Dhan" result={autologinResult.dhan} />
              <BrokerChip name="Zerodha" result={autologinResult.zerodha} />
              <BrokerChip name="Kotak" result={autologinResult.kotak} />
            </div>
          )}

          <div className="flex items-center gap-2.5">
            <Checkbox
              id="remember"
              checked={remember}
              onCheckedChange={(checked) => setRemember(Boolean(checked))}
              disabled={loading || autologinLoading}
            />
            <Label htmlFor="remember" className="cursor-pointer text-zinc-400">
              Remember this session{" "}
              <span className="text-xs text-zinc-600">(24 h)</span>
            </Label>
          </div>

          <button
            type="button"
            onClick={() => setShowManualForm(v => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
          >
            {showManualForm ? "Hide manual connect" : "Connect manually instead"}
          </button>
        </CardContent>

        {showManualForm && (
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4 pt-0">

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
        )}
      </Card>

      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
