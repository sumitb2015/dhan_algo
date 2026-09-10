"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

// On some Linux GPU/driver stacks (Mesa llvmpipe, VM/remote-desktop GL, older
// Intel drivers), framer-motion's rAF-driven SVG pathLength/pathOffset
// animation combined with the translateZ(0) compositor layer below triggers
// repeated GPU-process crashes in Chrome/Chromium, which surfaces as the
// whole page rapidly re-rendering/flickering. This does not reproduce on
// Windows' GPU stack, so the animation is disabled only on detected Linux —
// a static render of the same paths keeps the visual without the crash loop.
function useIsLinux() {
    const [isLinux, setIsLinux] = useState(false);
    useEffect(() => {
        const ua = navigator.userAgent;
        setIsLinux(/Linux/.test(ua) && !/Android/.test(ua));
    }, []);
    return isLinux;
}

export function FloatingPaths({ position }: { position: number }) {
    const isLinux = useIsLinux();

    const paths = Array.from({ length: 12 }, (_, i) => ({
        id: i,
        d: `M-${380 - i * 15 * position} -${189 + i * 18}C-${
            380 - i * 15 * position
        } -${189 + i * 18} -${312 - i * 15 * position} ${216 - i * 18} ${
            152 - i * 15 * position
        } ${343 - i * 18}C${616 - i * 15 * position} ${470 - i * 18} ${
            684 - i * 15 * position
        } ${875 - i * 18} ${684 - i * 15 * position} ${875 - i * 18}`,
        width: 0.6 + i * 0.08,
    }));

    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <svg
                className="w-full h-full text-emerald-500"
                viewBox="0 0 696 316"
                fill="none"
                preserveAspectRatio="xMidYMid slice"
                style={isLinux ? { overflow: "hidden" } : { overflow: "hidden", transform: "translateZ(0)" }}
            >
                <title>Background Paths</title>
                {paths.map((path) =>
                    isLinux ? (
                        <path
                            key={path.id}
                            d={path.d}
                            stroke="currentColor"
                            strokeWidth={path.width}
                            strokeOpacity={0.12 + path.id * 0.03}
                        />
                    ) : (
                        <motion.path
                            key={path.id}
                            d={path.d}
                            stroke="currentColor"
                            strokeWidth={path.width}
                            strokeOpacity={0.12 + path.id * 0.03}
                            initial={{ pathLength: 0.3, opacity: 0.5 }}
                            animate={{
                                pathLength: 1,
                                opacity: [0.25, 0.55, 0.25],
                                pathOffset: [0, 1, 0],
                            }}
                            transition={{
                                duration: 20 + (path.id % 6) * 3,
                                repeat: Number.POSITIVE_INFINITY,
                                ease: "easeInOut",
                            }}
                        />
                    )
                )}
            </svg>
        </div>
    );
}
