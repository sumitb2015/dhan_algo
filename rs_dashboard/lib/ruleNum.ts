// Parsing for free-typed rule inputs (components/multiLegFocus/RuleNumInput.tsx). Pure so it can be tested.

export type RuleNumParse = { kind: 'empty' } | { kind: 'value'; n: number } | { kind: 'invalid' };

/**
 * `signed = false` (the default, every SL / target / lots box): only numbers above 0 are values.
 * `signed = true` (Greek bands): any finite number is a value, including 0 and negatives. A short-premium book's net
 * delta and vega are mostly negative, so a band like "-150 to 150" must be typeable.
 */
export function parseRuleNum(raw: string, signed = false): RuleNumParse {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  // Unsigned keeps the original parseFloat behaviour every existing box relies on. Signed (new) is strict: "-12abc" is a
  // typo for a band limit, not -12.
  const n = signed ? Number(trimmed) : parseFloat(trimmed);
  if (!Number.isFinite(n)) return { kind: 'invalid' };
  if (!signed && !(n > 0)) return { kind: 'invalid' };
  return { kind: 'value', n };
}
