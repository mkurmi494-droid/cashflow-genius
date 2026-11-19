// Live exchange rates for currency conversion (server-side only).
// Source: https://open.er-api.com (ExchangeRate-API free endpoint) —
// no key, no account, rates refreshed daily by the provider. The rate
// is ALWAYS fetched live at conversion time: no hardcoded rates, no
// cache, no fallback rate. Any failure throws, so updateBusiness can
// refuse to change the currency label without converting the amounts
// with it. Same-currency changes never call this — the caller skips
// the fetch entirely.

/** One live rate: units of `to` per 1 unit of `from`. */
export interface LiveRate {
  rate: number;
  /** The date string the provider reports for this rate table. */
  asOf: string;
}

/** Convert integer minor units at a live rate, rounding to the nearest
 *  minor unit. All five app currencies (INR, USD, EUR, GBP, AED) have
 *  100 minor units, so no scale change is needed. Zero stays zero;
 *  negatives (e.g. a negative opening balance) convert the same way. */
export function convertMinor(oldMinor: number, rate: number): number {
  return Math.round(oldMinor * rate);
}

export async function fetchRate(from: string, to: string): Promise<LiveRate> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  let res: Response;
  try {
    res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new Error(
      `Could not fetch the live exchange rate (${f} → ${t}): ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Could not fetch the live exchange rate (${f} → ${t}): the rate provider returned HTTP ${res.status}. Nothing was changed.`,
    );
  }
  let data: unknown;
  try {
    data = (await res.json()) as unknown;
  } catch {
    throw new Error(
      `Could not fetch the live exchange rate (${f} → ${t}): the rate provider returned an unreadable response. Nothing was changed.`,
    );
  }
  const rates = (data as { rates?: Record<string, unknown> } | null)?.rates;
  const rate = rates?.[t];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      `Could not fetch the live exchange rate (${f} → ${t}): no live rate is available for ${t}. Nothing was changed.`,
    );
  }
  const asOfRaw = (data as { time_last_update_utc?: unknown } | null)?.time_last_update_utc;
  const asOf =
    typeof asOfRaw === "string" && asOfRaw ? asOfRaw : new Date().toISOString().slice(0, 10);
  return { rate, asOf };
}
