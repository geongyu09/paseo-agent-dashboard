import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { subAgentList, subAgentPrompts, subAgentTimeline } from "../shared/subagents";

let client: Promise<DaemonClient> | null = null;
let warned = false;

/**
 * A client of the daemon on this machine, at the address in the Paseo home's config.
 * shortcut: the plugin SDK has no provider subagent calls, so the plugin opens its own connection; a daemon that needs a
 * password or listens on a socket gets none and the board shows no subagents. Use the SDK once it exposes them.
 */
function daemon(): Promise<DaemonClient> {
  client ??= (async () => {
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { daemon?: { listen?: string } };
    const daemonClient = new DaemonClient({ url: `ws://${config.daemon?.listen ?? "127.0.0.1:6767"}/ws`, clientId: "paseo-agent-dashboard", reconnect: { enabled: true } });
    await daemonClient.connect();
    return daemonClient;
  })().catch((error) => {
    client = null;
    throw error;
  });
  return client;
}

const report = (error: unknown) => {
  if (warned) return;
  warned = true;
  console.error("[agent-board] subagents:", error instanceof Error ? error.message : error);
};

export async function listSubAgents({ agentIds }: RpcInput<typeof subAgentList>): Promise<RpcOutput<typeof subAgentList>> {
  try {
    const daemonClient = await daemon();
    const lists = await Promise.all(agentIds.map((id) => daemonClient.listProviderSubagents(id).then((list) => list.subagents, () => [])));
    return {
      subagents: lists.flat().map((sub) => ({
        id: sub.id,
        parentAgentId: sub.parentAgentId,
        parentSubagentId: sub.parentSubagentId ?? null,
        title: sub.title,
        description: sub.description,
        subtitle: sub.subtitle ?? null,
        status: sub.status,
        createdAt: sub.createdAt,
      })),
    };
  } catch (error) {
    report(error);
    return { subagents: [] };
  }
}

export async function listSubAgentPrompts({ agentId, subAgentId }: RpcInput<typeof subAgentPrompts>): Promise<RpcOutput<typeof subAgentPrompts>> {
  const page = await (await daemon()).fetchProviderSubagentTimeline(agentId, subAgentId, { direction: "tail", limit: 0 });
  return {
    prompts: page.rows.flatMap((row) =>
      // Claude reports the subagent's own background work to it as a user message; that is no instruction.
      row.item.type === "user_message" && !row.item.text.trimStart().startsWith("<task-notification>") ? [{ text: row.item.text, at: row.timestamp }] : [],
    ),
  };
}

export async function readSubAgentTimeline({ agentId, subAgentId }: RpcInput<typeof subAgentTimeline>): Promise<RpcOutput<typeof subAgentTimeline>> {
  const page = await (await daemon()).fetchProviderSubagentTimeline(agentId, subAgentId, { direction: "tail", limit: 0 });
  return { items: page.rows.map((row) => row.item) };
}

export async function stopSubAgents(): Promise<void> {
  const pending = client;
  client = null;
  await pending?.then((daemonClient) => daemonClient.close(), () => {});
}
