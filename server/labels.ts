import type { RpcOutput } from "@getpaseo/plugin";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { workspaceLabels } from "../shared/labels";

/**
 * Reads the label definitions Paseo keeps beside its workspace list; no file or an unreadable one means no colors.
 * shortcut: reads the daemon's own file because the plugin SDK has no label list; switch to the SDK once it has one.
 */
export async function listLabels(): Promise<RpcOutput<typeof workspaceLabels>> {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, "projects", "workspace-labels.json"), "utf8"));
    const labels = Array.isArray(parsed)
      ? parsed.filter((label): label is { name: string; color: string } => typeof label?.name === "string" && typeof label?.color === "string")
      : [];
    return { labels: labels.map(({ name, color }) => ({ name, color })) };
  } catch {
    return { labels: [] };
  }
}
