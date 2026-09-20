// plotly.js-gl3d-dist-min ships no typings; we only use the handful of
// calls in components/OptionScatter3D.tsx, so a loose module is enough.
declare module 'plotly.js-gl3d-dist-min' {
  const Plotly: {
    react: (el: HTMLElement, data: unknown[], layout?: unknown, config?: unknown) => Promise<unknown>;
    purge: (el: HTMLElement) => void;
    Plots: { resize: (el: HTMLElement) => void };
  };
  export default Plotly;
}
