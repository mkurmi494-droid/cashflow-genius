// Minimal action-definition shim replacing @hatch/space-sdk on Vercel.
// defineAction keeps the request/response zod schemas attached so the
// client can derive its typed RPC surface from `Actions` exactly as it
// did in the Muse runtime. Handlers receive a small ctx object; the
// ported actions use the module db singleton (./db) and aiComplete
// (./ai) directly instead of ctx.db / ctx.inference.
import { z } from "zod";

export { z };

export interface Ctx {
  invalidateQueries(): void;
}

export interface ActionDef<
  TReq extends z.ZodTypeAny = z.ZodTypeAny,
  TRes extends z.ZodTypeAny = z.ZodTypeAny,
> {
  description?: string;
  request: TReq;
  response: TRes;
  handler: (ctx: Ctx, args: z.infer<TReq>) => Promise<z.infer<TRes>>;
}

export function defineAction<
  TReq extends z.ZodTypeAny,
  TRes extends z.ZodTypeAny,
>(def: ActionDef<TReq, TRes>): ActionDef<TReq, TRes> {
  return def;
}

export type ActionsModule = Record<string, ActionDef>;
