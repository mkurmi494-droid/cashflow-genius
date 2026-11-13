// Safe-area top scrim (replaces the Muse runtime's SafeAreaTopScrim):
// a plain spacer that keeps content clear of phone notches / status bars.
export function SafeAreaTopScrim({
  backgroundColor,
}: {
  backgroundColor?: string;
}) {
  return (
    <div
      aria-hidden
      style={{
        height: "env(safe-area-inset-top, 0px)",
        backgroundColor: backgroundColor ?? "var(--bg)",
      }}
    />
  );
}
