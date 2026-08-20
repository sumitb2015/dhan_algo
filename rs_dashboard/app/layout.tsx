import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Relative Strength Scanner | Nifty 50 & Nifty 500 Mansfield RS",
  description: "Advanced analytics dashboard for Nifty index members using Mansfield Relative Strength methodology",
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
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
