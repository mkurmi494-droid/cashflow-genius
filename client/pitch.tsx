// "Why Cashflow Genius?" — the judges' pitch, inside the app. Every
// claim here is written to match what the app actually does today:
// honest limits included (no live bank/UPI auto-sync; Supabase is
// connected for Google sign-in only, Gemini not connected until a
// real call is wired and verified), and the
// business model is labelled as the plan — nothing is paywalled in
// this build, which the copy says plainly instead of pretending a
// Pro tier already exists.

export function WhyCashflowGenius({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-4 text-left">
      <div>
        <h3 className="text-sm font-extrabold">The problem</h3>
        <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
          Money apps track the past or do full accounting — almost none answer <strong className="text-[var(--text)]">“What happens to my money next?”</strong>{" "}
          Cashflow Genius is built around that question: a forecast, a payment calendar, a leak
          scanner, savings pace, and an AI CFO that answers from your real figures.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-extrabold">India-first, by design</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--dim)]">
          <li><strong className="text-[var(--text)]">UPI first:</strong> UPI first on every entry, with voice entry and paste-a-bank-SMS import — always confirmed by you, always verified in your bank/UPI app.</li>
          <li><strong className="text-[var(--text)]">INR + GST native:</strong> Indian numbering, GST-ready invoices with a GSTR-1 style export, EMI plans for products sold on instalments.</li>
          <li><strong className="text-[var(--text)]">Multilingual AI CFO:</strong> Ask in English or Hindi; answers come back in your language, grounded in your numbers, with sources shown.</li>
          <li><strong className="text-[var(--text)]">Scam Shield:</strong> Fake UPI messages and payment screenshots checked for scam signs.</li>
        </ul>
      </div>

      {!compact ? (
        <div>
          <h3 className="text-sm font-extrabold">How it&rsquo;s different</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--dim)]">
                  <th className="py-2 pr-3 font-extrabold"> </th>
                  <th className="py-2 pr-3 font-extrabold text-[var(--accent)]">Cashflow Genius</th>
                  <th className="py-2 pr-3 font-extrabold">YNAB</th>
                  <th className="py-2 pr-3 font-extrabold">Zoho Books</th>
                  <th className="py-2 font-extrabold">QuickBooks</th>
                </tr>
              </thead>
              <tbody className="text-[var(--dim)]">
                <tr className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3 font-bold text-[var(--text)]">Focus</td>
                  <td className="py-2 pr-3">Forward cashflow — what happens next</td>
                  <td className="py-2 pr-3">Budgeting the past month</td>
                  <td className="py-2 pr-3">Accounting &amp; compliance</td>
                  <td className="py-2">Accounting &amp; invoicing</td>
                </tr>
                <tr className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3 font-bold text-[var(--text)]">Personal + business</td>
                  <td className="py-2 pr-3">Both, in fully separate workspaces, usable together</td>
                  <td className="py-2 pr-3">Personal only</td>
                  <td className="py-2 pr-3">Business only</td>
                  <td className="py-2">Business only</td>
                </tr>
                <tr className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3 font-bold text-[var(--text)]">India fit</td>
                  <td className="py-2 pr-3">UPI, GST, INR, EMI, English + Hindi AI, scam checks</td>
                  <td className="py-2 pr-3">US-first, USD</td>
                  <td className="py-2 pr-3">GST yes; no personal money or scam shield</td>
                  <td className="py-2">Global accounting, not UPI-native</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-bold text-[var(--text)]">AI answers</td>
                  <td className="py-2 pr-3">Grounded in your real figures, sources shown, never invents a number</td>
                  <td className="py-2 pr-3">—</td>
                  <td className="py-2 pr-3">Reports assistant</td>
                  <td className="py-2">Assistant features</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="text-sm font-extrabold">Honest limits — we say these before you ask</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--dim)]">
          <li><strong className="text-[var(--text)]">No live bank/UPI auto-sync:</strong> there is no UPI API for apps like this. Entry is Quick Add, voice, CSV import, or paste-a-message with your confirmation.</li>
          <li><strong className="text-[var(--text)]">Supabase powers Google sign-in and email verification; Gemini is not connected.</strong> The AI CFO runs on ChatGPT, grounded in your figures. We never display a connection we don&rsquo;t have.</li>
          <li><strong className="text-[var(--text)]">Forecasts are estimates,</strong> calculated from your recorded dues and schedules, with their assumptions listed — never guarantees.</li>
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-extrabold">Your data &amp; privacy</h3>
        <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
          Every account starts empty and private. The three money modes are completely separate workspaces. Full JSON backup and restore are built in, deletes come with Undo, and account deletion is in Settings.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-extrabold">Business model (the plan)</h3>
        <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
          <strong className="text-[var(--text)]">Free basic, forever.</strong> <strong className="text-[var(--text)]">Pro (planned):</strong> the AI CFO and advanced reports. In this build nothing is paywalled, and there are no ads and no loan offers, ever.
        </p>
      </div>
    </div>
  );
}
