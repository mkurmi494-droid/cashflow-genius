import type { State } from "./lib";
import type { ConfirmOptions } from "./safety";

export type Route =
  | "dashboard"
  | "ai-cfo"
  | "money-flow"
  | "payment-calendar"
  | "future-lens"
  | "what-if-lab"
  | "invoices"
  | "profit-scanner"
  | "tax"
  | "reports"
  | "memory-vault"
  | "scam-shield"
  | "savings"
  | "lend-borrow"
  | "settings";

export interface PageProps {
  state: State;
  go: (r: Route) => void;
  notify: (msg: string) => void;
  /** Shows the post-delete snackbar with a working Undo button that
   *  restores the exact deleted record (server snapshot id). */
  notifyDeleted: (msg: string, trashId: string | null | undefined, label?: string) => void;
  /** Asks the user to confirm a delete or a big/irreversible step.
   *  Resolves true only when they tap the confirm button. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  saveToVault: (
    title: string,
    content: string,
    sourceModule: string,
  ) => Promise<void>;
  openNoteId?: string | null;
  /** Opens the global Quick Add transaction sheet (available from every page). */
  onQuickAdd?: () => void;
  /** Opens the onboarding app tour (also re-openable from Settings). */
  onShowTour?: () => void;
  /** True while the top-bar currency conversion is running — the
   *  Settings currency control disables itself meanwhile so a second
   *  conversion can never be fired behind the first. */
  currencyBusy?: boolean;
}
