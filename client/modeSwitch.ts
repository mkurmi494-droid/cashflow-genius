// Mode-switch loading gate (bug fix, 2026-11-15).
//
// After a mode switch the optimistic patch (client/optimistic.ts)
// deliberately clears the old workspace's lists, so the cached
// ["cg-state"] briefly holds EMPTY lists under the NEW mode's name —
// and the pages render their empty states ("Your universe is empty",
// "Nothing recorded yet") from that cache. That is wrong whenever
// the new workspace actually has records: live, the refetch that
// fills those lists takes seconds (cold start + cross-region DB
// round-trips), so the demo showed an empty workspace first and
// the real data only after ~15–30s.
//
// So a mode switch must NEVER render the pages from the cleared
// cache: while the switch is in flight the app shows an honest
// loading skeleton ("Loading Personal Money…") instead, and the
// empty states only ever render after a completed fetch actually
// returned zero records. The gate lives in App (not in the pages),
// because both switch entry points — the header/Settings switcher
// (App's modeMut) and the Home dual-mode panel — go through
// api.setMode, which dispatches the same "cg:mutated" event.
//
// Pure function, so the harness can test the real rule without
// rendering React: given the switch target, the mode the cached
// state currently reports, and the query's fetch/error flags, say
// whether the loading skeleton must be shown instead of the pages.
import type { AppMode } from "./lib";

/** Safety net: if the refetch never settles (network dropped, a
 *  failed fetch with retry: false), the gate must not stick the app
 *  on the skeleton forever — App clears the pending switch after
 *  this long and lets the normal error/empty branches render. */
export const MODE_SWITCH_TIMEOUT_MS = 30_000;

export function shouldShowModeSwitchLoading(args: {
  switchingTo: AppMode | null;
  activeMode: AppMode | null;
  isFetching: boolean;
  isError: boolean;
}): boolean {
  const { switchingTo, activeMode, isFetching, isError } = args;
  if (!switchingTo) return false;
  // A failed refetch must surface the error screen, never the
  // skeleton and never the cleared cache as an empty workspace.
  if (isError) return false;
  // Still waiting while the refetch is in flight, or while the
  // cached state still reports the old mode (the patch sets the new
  // mode in the same tick as the switch, so this second case is
  // only a belt-and-braces check).
  return isFetching || activeMode !== switchingTo;
}
