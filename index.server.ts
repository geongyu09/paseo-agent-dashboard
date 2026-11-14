import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listLabels } from "./server/labels";
import { listSubAgentPrompts, listSubAgents, readSubAgentTimeline, stopSubAgents } from "./server/subagents";
import { stopSummaries, summarize, summarizeInstruction } from "./server/summary";
import { workspaceLabels } from "./shared/labels";
import { boardLayout } from "./shared/layout";
import { subAgentList, subAgentPrompts, subAgentTimeline } from "./shared/subagents";
import { agentSummary, instructionSummary } from "./shared/summary";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(boardLayout);
  server.handle(agentSummary, summarize);
  server.handle(instructionSummary, summarizeInstruction);
  server.handle(workspaceLabels, listLabels);
  server.handle(subAgentList, listSubAgents);
  server.handle(subAgentPrompts, listSubAgentPrompts);
  server.handle(subAgentTimeline, readSubAgentTimeline);
  return () => Promise.all([stopSummaries(), stopSubAgents()]).then(() => {});
}
