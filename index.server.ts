import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listLabels } from "./server/labels";
import { stopSummaries, summarize, summarizeInstruction } from "./server/summary";
import { workspaceLabels } from "./shared/labels";
import { boardLayout } from "./shared/layout";
import { agentSummary, instructionSummary } from "./shared/summary";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(boardLayout);
  server.handle(agentSummary, summarize);
  server.handle(instructionSummary, summarizeInstruction);
  server.handle(workspaceLabels, listLabels);
  return stopSummaries;
}
