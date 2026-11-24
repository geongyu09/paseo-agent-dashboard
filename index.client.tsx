import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentBoard } from "./client/AgentBoard";
import { keywords, messages } from "./client/messages";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addWorkspacePanel({
      id: "board",
      title: messages.message("panel.title"),
      icon: "Workflow",
      locations: ["workspace", "explorer"],
      Component: AgentBoard,
    }),
    client.addCommandCenterItem({
      id: "open-board",
      title: messages.message("panel.open"),
      icon: "Workflow",
      keywords,
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("board");
      },
    }),
  ];
  return () => removers.forEach((remove) => remove());
}
