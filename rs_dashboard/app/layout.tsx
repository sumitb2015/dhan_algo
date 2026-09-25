import type { Metadata } from "next";
import { Inter, Geist_Mono, Poppins, DM_Sans, Playfair_Display, Lora, Montserrat } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import ThemeInit from "@/components/ThemeInit";
import Sidebar from "@/components/Sidebar";
import { Toaster } from "sonner";
import Script from "next/script";
import "./globals.css";

// Inter over Geist: hand-tuned hinting for small UI text (this app's sidebar
// and tables run 11-12px), which is what this app needs most.
// Named `--font-sans` (not `--font-geist-sans`) to match the `--font-sans`
// bridge already declared in globals.css's `@theme inline` block — that var
// was previously never actually set by anything, so the `font-sans` utility
// (applied explicitly in several components, e.g. BreadthAnalysis.tsx
// tooltips) only worked by accident, via inheriting body's own explicit
// font-family rule rather than resolving its own theme token.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Selectable heading fonts (Settings > Typography, lib/preferences.ts).
// All five load unconditionally — next/font requires a static import per
// font — but only the user's chosen one is ever assigned to `--heading-font`
// (app/globals.css), so the unused ones cost a stylesheet entry, not a paint.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
});
const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
});
const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
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
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
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
            },
          }}
        />
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
