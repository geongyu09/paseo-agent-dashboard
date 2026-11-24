import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A short title for the agent's session and what it is doing now, written by a model from its recent timeline in the app language. */
export const agentSummary = defineRpc({
  name: "agent.summary",
  input: z.object({ agentId: z.string(), running: z.boolean(), locale: z.string().max(35) }),
  output: z.object({ title: z.string().nullable(), doing: z.string().nullable() }),
});

/** An instruction one agent sent another, summarized for a person: its goal and its main requirements. */
export const instructionSummary = defineRpc({
  name: "instruction.summary",
  input: z.object({ text: z.string(), locale: z.string().max(35) }),
  output: z.object({ goal: z.string().nullable(), points: z.array(z.string()) }),
});
