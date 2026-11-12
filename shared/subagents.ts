import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const subAgent = z.object({
  /** The tool call id that started it. */
  id: z.string(),
  /** The Paseo agent whose session runs it. */
  parentAgentId: z.string(),
  /** The subagent that started it, when subagents nest. */
  parentSubagentId: z.string().nullable(),
  /** The subagent type, such as Explore. */
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** Paseo's line of type, model, effort and tokens. */
  subtitle: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  createdAt: z.string(),
});

/**
 * A subagent an agent started inside its own session (Claude's Agent tool, for one). It is not a Paseo agent; the daemon
 * tracks it apart from the agent list and keeps its true state, which the parent's timeline does not for background ones.
 */
export type SubAgent = z.infer<typeof subAgent>;

/** The subagents of the given agents, as the daemon tracks them. */
export const subAgentList = defineRpc({
  name: "subagents.list",
  input: z.object({ agentIds: z.array(z.string()).max(200) }),
  output: z.object({ subagents: z.array(subAgent) }),
});

/** The messages a subagent was given, oldest first: the task it was started with, then follow-ups. */
export const subAgentPrompts = defineRpc({
  name: "subagents.prompts",
  input: z.object({ agentId: z.string(), subAgentId: z.string() }),
  output: z.object({ prompts: z.array(z.object({ text: z.string(), at: z.string() })) }),
});
