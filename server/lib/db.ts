// Supabase Postgres connection (Drizzle, postgres-js driver).
// DATABASE_URL must be the Supabase Postgres connection string — use the
// Session Pooler URL from the Supabase dashboard (Project Settings →
// Database → Connection string, port 6543, with ?sslmode=require) so
// Vercel's serverless functions can connect. Never put the Supabase
// service-role key here; this connection uses the postgres password
// only, and every query is still scoped by owner_id in the actions.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";

const url = process.env.DATABASE_URL;
if (!url) {
  // Throwing at import time would break `next build` (which collects the
  // API routes); instead the client is created lazily and the error
  // surfaces on the first real query with a clear message.
  console.warn(
    "[cashflow-genius] DATABASE_URL is not set — API calls will fail until the Supabase Postgres connection string is configured in Vercel env vars.",
  );
}

// SSL is required for Supabase (hosted) but must be off for plain local
// Postgres. The Supabase pooler URL carries ?sslmode=require; honour
// that, and require SSL for any non-localhost host.
const needsSsl = url
  ? url.includes("sslmode=require") ||
    (!url.includes("localhost") && !url.includes("127.0.0.1"))
  : false;
const client = url ? postgres(url, { ssl: needsSsl, max: 1 }) : null;

export const db = client
  ? drizzle(client, { schema })
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(
            "DATABASE_URL is not set. Add the Supabase Postgres connection string (Session Pooler, port 6543) in Vercel → Settings → Environment Variables as DATABASE_URL, then redeploy.",
          );
        },
      },
    ) as ReturnType<typeof drizzle>);
