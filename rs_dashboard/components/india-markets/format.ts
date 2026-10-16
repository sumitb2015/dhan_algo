// India Markets formatting. Display only.
export const inr = (v: number | null, dec = 2) => (v == null ? '–' : v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }));

/** IST calendar date of a ms epoch. */
export const istDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
