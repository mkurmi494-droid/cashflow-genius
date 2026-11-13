"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { App } from "../client/App";
import { ParticleCursor } from "../client/particleCursor";
import { initPwa } from "../client/pwa";

// Cashflow Genius is a single-page app: the whole UI lives in client/App.
// initPwa() is best-effort and never blocks first render.
if (typeof window !== "undefined") initPwa();

export default function Home() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <div className="hatch-space-root" data-hatch-space-root>
          <App />
          <ParticleCursor />
        </div>
      </QueryClientProvider>
    </StrictMode>
  );
}
