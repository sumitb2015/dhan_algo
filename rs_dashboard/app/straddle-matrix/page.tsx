import NavBar from '@/components/NavBar';
import StraddleLiveMatrix from '@/components/StraddleLiveMatrix';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ATM Straddle Matrix | Dhan Algo Trading',
  description: 'Live current-day ATM short straddle performance matrix across timestamps and leg-wise Stop Loss percentages',
};

export default function StraddleMatrixPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      <NavBar />
      <main className="flex-1 p-3 sm:p-4 max-w-[1680px] mx-auto w-full flex flex-col gap-4">
        <StraddleLiveMatrix />
      </main>
    </div>
  );
}

