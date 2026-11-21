import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cashflow Genius — See money before it moves",
  description:
    "Cashflow Genius — The Living Ledger. One calm home for your money: cashflow, what's due, savings goals, invoices with GST, a scam check for suspicious UPI messages, and an AI CFO that answers from your real numbers.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Cashflow Genius", statusBarStyle: "default" },
  icons: {
    icon: "/icon-192.png",
    /* The tab favicon: a real Sprout .ico in public/ so /favicon.ico
       serves the logo on every host (it was a 404 on Vercel and a
       wrong black asterisk on Netlify). */
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  /* Link previews (WhatsApp/Telegram/etc.) had no image to use, so they
     showed a stale cached copy of the old ₹ tile. Point them at the new
     Sprout logo explicitly so fresh shares preview the current logo. */
  openGraph: {
    title: "Cashflow Genius — See money before it moves",
    description:
      "Cashflow Genius — The Living Ledger. One calm home for your money: cashflow, what's due, savings goals, invoices with GST, a scam check for suspicious UPI messages, and an AI CFO that answers from your real numbers.",
    url: "https://cashflow-genius.vercel.app",
    siteName: "Cashflow Genius",
    images: [
      {
        url: "https://cashflow-genius.vercel.app/icon-512.png",
        width: 512,
        height: 512,
        alt: "Cashflow Genius logo",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Cashflow Genius — See money before it moves",
    description:
      "Cashflow Genius — The Living Ledger. One calm home for your money: cashflow, what's due, savings goals, invoices with GST, a scam check for suspicious UPI messages, and an AI CFO that answers from your real numbers.",
    images: ["https://cashflow-genius.vercel.app/icon-512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#7c3aed",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
