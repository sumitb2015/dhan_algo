// Shared layout for all options-related routes. Every page under this layout
// renders NavBar itself, inline at the far right of its own sticky header —
// this layout used to also render a separate NavBar-only strip above every
// page, but that was a 3rd header level stacked on top of a page's own title
// row and its tab row, so each page took it over instead. Nothing here needs
// NavBar anymore now that /options/live-charts (the last holdout — its own
// bespoke full-height shell, not the sticky-header pattern everywhere else)
// has its own copy too.
export default function OptionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {children}
    </div>
  );
}
