import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { SUMMARY_MODELS } from "./summary";

/** Card positions the user dragged, by agent id (agents without one use the tree layout), whether summaries run, and the chosen summary model (null: the first ready one). */
export const boardLayout = defineSettings({
  id: "layout",
  scope: "host",
  version: 1,
  schema: z.object({
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
    summaries: z.boolean().default(true),
    model: z.enum(SUMMARY_MODELS).nullable().default(null),
  }),
});
