'use client';

import { Camera, RotateCcw, Play, Pause, Maximize2, Minimize2, Compass } from 'lucide-react';
import type { CameraView } from './shared';

interface Props {
  setCameraView: (v: CameraView) => void;
  isOrbiting: boolean; setIsOrbiting: (fn: (prev: boolean) => boolean) => void;
  dragMode: 'turntable' | 'orbit'; setDragMode: (fn: (prev: 'turntable' | 'orbit') => 'turntable' | 'orbit') => void;
  showStems: boolean; setShowStems: (fn: (prev: boolean) => boolean) => void;
  showZeroPlanes: boolean; setShowZeroPlanes: (fn: (prev: boolean) => boolean) => void;
  showFloorShadow: boolean; setShowFloorShadow: (fn: (prev: boolean) => boolean) => void;
  isFullscreen: boolean;
  onSnapshot: () => void;
  onToggleFullscreen: () => void;
}

/** Floating glass toolbars: camera presets (left) and layers / orbit / snapshot / fullscreen (right). */
export function ViewportToolbar({
  setCameraView, isOrbiting, setIsOrbiting, dragMode, setDragMode, showStems, setShowStems,
  showZeroPlanes, setShowZeroPlanes, showFloorShadow, setShowFloorShadow, isFullscreen, onSnapshot, onToggleFullscreen,
}: Props) {
  return (
        <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between gap-2 flex-wrap pointer-events-none">
          {/* Camera View Presets */}
          <div className="flex items-center gap-1 bg-zinc-950/85 backdrop-blur-md border border-zinc-700/60 p-1 rounded-xl shadow-lg pointer-events-auto">
            <button
              onClick={() => setCameraView('iso')}
              className="px-2 py-1 rounded-lg text-[11px] font-bold text-zinc-300 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title="3D Perspective Isometric View"
            >
              3D Iso
            </button>
            <button
              onClick={() => setCameraView('top')}
              className="px-2 py-1 rounded-lg text-[11px] font-bold text-zinc-300 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title="Top-down 2D Quadrant View (Price vs OI)"
            >
              Top (Price × OI)
            </button>
            <button
              onClick={() => setCameraView('front')}
              className="px-2 py-1 rounded-lg text-[11px] font-bold text-zinc-300 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title="Front Elevation (Price vs IV Skew)"
            >
              Front (Price × IV)
            </button>
            <button
              onClick={() => setCameraView('side')}
              className="px-2 py-1 rounded-lg text-[11px] font-bold text-zinc-300 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title="Side Elevation (OI vs IV Positioning)"
            >
              Side (OI × IV)
            </button>
            <button
              onClick={() => setCameraView('atm')}
              className="px-2 py-1 rounded-lg text-[11px] font-bold text-amber-300 hover:text-amber-200 hover:bg-zinc-800/80 transition-colors"
              title="Closer, lower-angle view"
            >
              Close-up
            </button>
            <button
              onClick={() => setCameraView('reset')}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title="Reset Camera View"
              aria-label="Reset camera view"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Right Toolbar: Orbit, Layer Toggles, Snapshot, Fullscreen */}
          <div className="flex items-center gap-1.5 bg-zinc-950/85 backdrop-blur-md border border-zinc-700/60 p-1 rounded-xl shadow-lg pointer-events-auto">
            {/* Auto Turntable Orbit */}
            <button
              onClick={() => setIsOrbiting(prev => !prev)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition-colors ${
                isOrbiting ? 'bg-emerald-600 text-oncolor' : 'text-zinc-300 hover:text-white hover:bg-zinc-800/80'
              }`}
              title="Auto-rotate 360° Turntable"
            >
              {isOrbiting ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {isOrbiting ? 'Orbiting' : 'Orbit'}
            </button>

            {/* Drag Mode Toggle */}
            <button
              onClick={() => setDragMode(prev => prev === 'turntable' ? 'orbit' : 'turntable')}
              className={`p-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                dragMode === 'turntable' ? 'text-cyan-400 bg-cyan-950/40 border border-cyan-700/50' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title={`Drag Mode: ${dragMode === 'turntable' ? 'Turntable (Z-locked)' : 'Free Orbit'}`}
              aria-label="Toggle drag mode"
            >
              <Compass className="w-3.5 h-3.5" />
            </button>

            <span className="w-px h-4 bg-zinc-800 shrink-0" />

            {/* Display Layers Toggles */}
            <button
              onClick={() => setShowStems(prev => !prev)}
              className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                showStems ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle Vertical Drop Needles / Stems"
            >
              Needles
            </button>

            <button
              onClick={() => setShowZeroPlanes(prev => !prev)}
              className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                showZeroPlanes ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle Zero Reference Divider Planes"
            >
              Planes
            </button>

            <button
              onClick={() => setShowFloorShadow(prev => !prev)}
              className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                showFloorShadow ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle 2D Floor Shadow Projection"
            >
              Shadow
            </button>

            <span className="w-px h-4 bg-zinc-800 shrink-0" />

            {/* Snapshot HD PNG */}
            <button
              onClick={onSnapshot}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title="Download 1920×1080 PNG snapshot"
              aria-label="Download snapshot"
            >
              <Camera className="w-3.5 h-3.5" />
            </button>

            {/* Fullscreen Toggle */}
            <button
              onClick={onToggleFullscreen}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
              title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

  );
}
