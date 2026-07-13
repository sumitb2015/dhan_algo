// Instant route-level skeleton shown while a page in this group compiles /
// loads. One file covers every route in the (options) group.
export default function Loading() {
  return (
    <div className="px-6 py-4 animate-pulse">
      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="h-4 w-44 bg-zinc-800 rounded mb-2" />
          <div className="h-2.5 w-64 bg-zinc-900 rounded" />
        </div>
        <div className="flex gap-2">
          <div className="h-7 w-24 bg-zinc-900 border border-zinc-800 rounded-lg" />
          <div className="h-7 w-24 bg-zinc-900 border border-zinc-800 rounded-lg" />
        </div>
      </div>
      {/* Chart placeholders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="h-72 bg-zinc-900/60 border border-zinc-800/60 rounded-xl" />
        <div className="h-72 bg-zinc-900/60 border border-zinc-800/60 rounded-xl" />
        <div className="h-72 bg-zinc-900/60 border border-zinc-800/60 rounded-xl lg:col-span-2" />
      </div>
    </div>
  );
}
