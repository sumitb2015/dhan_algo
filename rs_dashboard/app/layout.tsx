import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import ThemeInit from "@/components/ThemeInit";
import Sidebar from "@/components/Sidebar";
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

export const metadata: Metadata = {
  title: {
    default: "Relative Strength Scanner | Nifty 50 & Nifty 500 Mansfield RS",
    template: "%s | Dhan Algo",
  },
  description: "Advanced analytics dashboard for Nifty index members and F&O derivatives trading",
};

/**
 * Applies the stored theme before first paint, so a light-mode user never
 * sees a flash of the dark shell. SSR renders `dark` (the historical
 * default, and what lib/theme.ts uses as its server snapshot); this script
 * strips the class when the stored preference resolves to light.
 * Keep the storage key in sync with THEME_STORAGE_KEY in lib/theme.ts.
 */
const THEME_INIT_SCRIPT = `(function(){try{
var m=localStorage.getItem('dhan-theme')||'dark';
var d=m!=='light';
var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';
}catch(_){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} dark h-full antialiased`}
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
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
