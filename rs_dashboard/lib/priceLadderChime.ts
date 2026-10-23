// Which sound a batch of Price Ladder events deserves. Pure: the page plays it. A problem outranks an exit and an exit
// outranks an entry, so a burst never hides a rejection behind a friendly sound.

export type ChimeKind = 'warn' | 'exit' | 'entry';

export function chimeFor(messages: string[]): ChimeKind | null {
  let kind: ChimeKind | null = null;
  for (const m of messages) {
    if (/UNKNOWN|rejected/i.test(m)) return 'warn';
    if (/exited|SIM exit/i.test(m)) kind = 'exit';
    else if (/ filled /i.test(m) && kind !== 'exit') kind = 'entry';
  }
  return kind;
}
