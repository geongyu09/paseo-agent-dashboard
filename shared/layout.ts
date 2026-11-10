import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Card positions the user dragged, by agent id (agents without one use the tree layout), and whether Haiku summaries run. */
export const boardLayout = defineSettings({
  id: "layout",
  scope: "host",
  version: 1,
  schema: z.object({
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
    summaries: z.boolean().default(true),
  }),
});
