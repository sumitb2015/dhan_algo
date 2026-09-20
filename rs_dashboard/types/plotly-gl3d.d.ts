// plotly.js-gl3d-dist-min ships no typings; this covers only the calls made in
// components/OptionScatter3D.tsx. Extend it here rather than casting to `any`.
declare module 'plotly.js-gl3d-dist-min' {
  export interface PlotlyEvent {
    points?: { customdata?: unknown }[];
    event?: MouseEvent;
  }
  /** The graph div, once Plotly has attached its event emitter to it. */
  export type PlotlyRoot = HTMLElement & {
    on?: (event: string, cb: (d: PlotlyEvent) => void) => void;
    removeAllListeners?: (event: string) => void;
  };
  const Plotly: {
    react: (el: HTMLElement, data: unknown[], layout?: unknown, config?: unknown) => Promise<unknown>;
    relayout: (el: HTMLElement, update: Record<string, unknown>) => Promise<unknown>;
    purge: (el: HTMLElement) => void;
    downloadImage: (
      el: HTMLElement,
      opts: { format: 'png' | 'svg' | 'jpeg' | 'webp'; width: number; height: number; filename: string },
    ) => Promise<string>;
    Plots: { resize: (el: HTMLElement) => void };
  };
  export default Plotly;
}
