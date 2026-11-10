import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The host's workspace label definitions: each label's name and Paseo color name. */
export const workspaceLabels = defineRpc({
  name: "workspace.labels",
  input: z.object({}),
  output: z.object({ labels: z.array(z.object({ name: z.string(), color: z.string() })) }),
});
