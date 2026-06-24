'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Terminal, RefreshCw, ArrowDown, Clipboard } from 'lucide-react';

interface LogConsoleProps {
  strategyKey: string;
  isActive: boolean;
}

export default function LogConsole({ strategyKey, isActive }: LogConsoleProps) {
  const [logs, setLogs] = useState<string>('Loading logs...');
  const [loading, setLoading] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const consoleRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch(`/api/strategies/logs?strategy=${strategyKey}`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs || 'No logs available.');
      } else {
        setLogs(`Error loading logs: ${data.error}`);
      }
    } catch (err) {
      setLogs('Network error. Failed to retrieve strategy logs.');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  // Poll logs periodically when strategy is active or panel is open
  useEffect(() => {
    fetchLogs(true);
    
    // Poll logs every 2 seconds if active, otherwise every 5 seconds
    const intervalTime = isActive ? 2000 : 5000;
    const interval = setInterval(() => {
      fetchLogs(false);
    }, intervalTime);

    return () => clearInterval(interval);
  }, [strategyKey, isActive]);

  // Handle autoscrolling to the bottom
  useEffect(() => {
    if (autoScroll && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Colorize log levels for a terminal theme
  const formatLogs = (text: string) => {
    return text.split('\n').map((line, idx) => {
      if (!line.trim()) return null;

      let coloredLine = line;
      // Color code log tags
      if (line.includes(' - INFO - ') || line.includes('INFO:')) {
        coloredLine = line.replace(/(- INFO -|INFO:)/g, '<span class="text-emerald-400 font-semibold">$1</span>');
      } else if (line.includes(' - WARNING - ') || line.includes('WARNING:')) {
        coloredLine = line.replace(/(- WARNING -|WARNING:)/g, '<span class="text-amber-400 font-semibold">$1</span>');
      } else if (line.includes(' - ERROR - ') || line.includes('ERROR:') || line.includes(' - CRITICAL - ') || line.includes('CRITICAL:')) {
        coloredLine = line.replace(/(- ERROR -|ERROR:|- CRITICAL -|CRITICAL:)/g, '<span class="text-rose-500 font-bold">$1</span>');
      }

      // Highlight key indicators like Nifty spot, CE, PE prices and PnL
      coloredLine = coloredLine
        .replace(/(PnL:\s*[-+]?₹?\d+\.?\d*)/gi, '<span class="text-teal-300 font-medium">$1</span>')
        .replace(/(Nifty:\s*\d+\.?\d*)/gi, '<span class="text-sky-300 font-medium">$1</span>')
        .replace(/(Diff:\s*\d+\.?\d*%)/gi, '<span class="text-indigo-300 font-medium">$1</span>');

      return (
        <div 
          key={idx} 
          className="py-0.5 border-b border-zinc-950/20 last:border-0"
          dangerouslySetInnerHTML={{ __html: coloredLine }}
        />
      );
    });
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(logs);
    alert('Logs copied to clipboard!');
  };

  return (
    <div className="flex flex-col h-96 bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden shadow-2xl relative">
      {/* Console Header */}
      <div className="flex items-center justify-between bg-zinc-900/60 px-4 py-2 border-b border-zinc-900">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-zinc-400" />
          <span className="text-xs font-mono font-bold text-zinc-300">Live Console Output</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyToClipboard}
            className="p-1 border border-zinc-800 rounded bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-all text-xs flex items-center gap-1"
            title="Copy logs"
          >
            <Clipboard className="h-3 w-3" />
            <span className="text-[10px] hidden sm:inline">Copy</span>
          </button>
          <button
            onClick={() => fetchLogs(true)}
            disabled={loading}
            className="p-1 border border-zinc-800 rounded bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-all text-xs flex items-center gap-1"
            title="Refresh logs"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            <span className="text-[10px] hidden sm:inline">Reload</span>
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 border rounded text-xs flex items-center gap-1 transition-all ${
              autoScroll
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-zinc-900/80 text-zinc-500 border-zinc-800 hover:text-zinc-300'
            }`}
            title="Pin to bottom"
          >
            <ArrowDown className="h-3 w-3" />
            <span className="text-[10px] hidden sm:inline">Pin</span>
          </button>
        </div>
      </div>

      {/* Terminal Display */}
      <div 
        ref={consoleRef}
        className="flex-1 p-4 overflow-y-auto font-mono text-[11px] text-zinc-300 bg-black/90 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent select-text"
      >
        {formatLogs(logs)}
      </div>
    </div>
  );
}
