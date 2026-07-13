import NavBar from '@/components/NavBar';

// Shared layout for all options-related routes. NavBar lives here (not inside
// each page component) so it persists across navigations instead of
// re-mounting, and stays interactive while the next page loads.
export default function OptionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="flex items-center px-6 py-2 border-b border-zinc-900 bg-zinc-950">
        <NavBar />
      </div>
      {children}
    </div>
  );
}
