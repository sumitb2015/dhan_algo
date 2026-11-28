import type { Metadata } from "next";
import localFont from "next/font/local";
import { TooltipProvider } from "@/components/ui/tooltip";
import ThemeInit from "@/components/ThemeInit";
import Sidebar from "@/components/Sidebar";
import KotakGuardBanner from "@/components/KotakGuardBanner";
import PriceAlertListener from "@/components/priceAlerts/PriceAlertListener";
import { Toaster } from "sonner";
import ThemeInitScript from "@/components/ThemeInitScript";
import "./globals.css";

// Fonts are self-hosted (app/fonts/, the latin .woff2 files Google Fonts serves) rather than loaded through
// next/font/google: Google intermittently answers with a new file-URL form (fonts.gstatic.com/l/font?kit=...) that
// Next 16.3.3's Turbopack font loader cannot parse ("next/font/google queries have exactly one entry"). Turbopack then
// caches the failure and every page returns 500 until the dev cache is cleared (2026-11-28, Montserrat). Local files
// need no network at build time. Same weights / variables as before.

// Inter over Geist: hand-tuned hinting for small UI text (this app's sidebar
// and tables run 11-12px), which is what this app needs most.
// Named `--font-sans` (not `--font-geist-sans`) to match the `--font-sans`
// bridge already declared in globals.css's `@theme inline` block — that var
// was previously never actually set by anything, so the `font-sans` utility
// (applied explicitly in several components, e.g. BreadthAnalysis.tsx
// tooltips) only worked by accident, via inheriting body's own explicit
// font-family rule rather than resolving its own theme token.
const inter = localFont({
  src: "./fonts/inter-100-900.woff2",
  weight: "100 900",
  variable: "--font-sans",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-100-900.woff2",
  weight: "100 900",
  variable: "--font-geist-mono",
});

// Selectable heading fonts (Settings > Typography, lib/preferences.ts).
// All five load unconditionally — next/font requires a static import per
// font — but only the user's chosen one is ever assigned to `--heading-font`
// (app/globals.css), so the unused ones cost a stylesheet entry, not a paint.
const poppins = localFont({
  src: [
    { path: "./fonts/poppins-500.woff2", weight: "500" },
    { path: "./fonts/poppins-600.woff2", weight: "600" },
    { path: "./fonts/poppins-700.woff2", weight: "700" },
  ],
  variable: "--font-poppins",
});
const dmSans = localFont({
  src: "./fonts/dm-sans-100-1000.woff2",
  weight: "100 1000",
  variable: "--font-dm-sans",
});
const playfair = localFont({
  src: "./fonts/playfair-display-400-900.woff2",
  weight: "400 900",
  variable: "--font-playfair",
});
const lora = localFont({
  src: "./fonts/lora-400-700.woff2",
  weight: "400 700",
  variable: "--font-lora",
});
// Google serves Montserrat 500 / 600 / 700 as one variable file.
const montserrat = localFont({
  src: "./fonts/montserrat-500-700.woff2",
  weight: "500 700",
  variable: "--font-montserrat",
});

export const metadata: Metadata = {
  title: {
    default: "Relative Strength Scanner | Nifty 50 & Nifty 500 Mansfield RS",
    template: "%s | Dhan Algo",
  },
  description: "Advanced analytics dashboard for Nifty index members and F&O derivatives trading",
};

/**
 * Applies the stored theme + heading-font preference before first paint, so
 * a light/beige-mode or custom-font user never sees a flash of the dark
 * shell / default font. SSR renders `dark` + the default font (the
 * historical default, and what lib/theme.ts + lib/preferences.ts use as
 * their server snapshot); this script sets the real attributes once the
 * stored preference is known. Keep the storage keys and value sets in sync
 * with lib/theme.ts and lib/preferences.ts.
 */
const THEME_INIT_SCRIPT = `(function(){try{
var m=localStorage.getItem('dhan-theme')||'dark';
if(m!=='light'&&m!=='dark'&&m!=='beige')m='dark';
var d=m==='dark';
var e=document.documentElement;e.classList.toggle('dark',d);e.setAttribute('data-theme',m);e.style.colorScheme=d?'dark':'light';
var f=localStorage.getItem('dhan-heading-font')||'inter';
if(f!=='inter'&&f!=='poppins'&&f!=='dmsans'&&f!=='playfair'&&f!=='lora'&&f!=='montserrat')f='inter';
e.setAttribute('data-heading-font',f);
}catch(_){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} ${poppins.variable} ${dmSans.variable} ${playfair.variable} ${lora.variable} ${montserrat.variable} dark h-full antialiased`}
      data-theme="dark"
      data-heading-font="inter"
      suppressHydrationWarning
    >
      <head>
        {/* Not next/script: see components/ThemeInitScript.tsx for why a client-rendered copy must stay inert. */}
        <ThemeInitScript code={THEME_INIT_SCRIPT} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeInit />
        {/* Mounted once here (not per-page inside NavBar) so it never
            unmounts/remounts — and its open-section state never resets —
            on navigation between pages that don't share a layout. */}
        <Sidebar />
        <Toaster
          position="top-center"
          theme="dark"
          toastOptions={{
            unstyled: true,
            classNames: {
              toast:
                'flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-3 shadow-2xl font-mono text-xs text-zinc-100 w-full',
              title: 'font-bold text-zinc-100',
              description: 'text-zinc-400 text-[11px]',
              success: '!border-emerald-500/30',
              error: '!border-red-500/30',
              icon: 'text-amber-400',
              actionButton: '!ml-auto shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-bold text-zinc-100 hover:bg-zinc-700 cursor-pointer',
            },
          }}
        />
        <KotakGuardBanner />
        {/* Price Alerts: one stream + alarm per tab, plus the header bell's panel and dialog (lib/priceAlertsUi.ts). */}
        <PriceAlertListener />
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
