import { Geist } from "next/font/google";

// Scoped display font for the Markets Overview pages — big headline price
// numbers and titles read better in Geist's geometric, tighter-tracked
// letterforms than Inter. Not applied app-wide: app/layout.tsx sticks with
// Inter deliberately for hinting at the 11-12px sizes most of the dashboard
// runs at (see the comment there), which Geist was never chosen for.
export const geistDisplay = Geist({
  variable: "--font-geist-display",
  subsets: ["latin"],
});
