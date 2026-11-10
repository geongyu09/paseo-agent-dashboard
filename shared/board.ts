import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/** Paseo labels an agent started by another agent with its parent's id; the snapshot has no parent field. */
export const PARENT_LABEL = "paseo.parent-agent-id";

export const CARD_W = 340;
/** Height assumed for a card until it reports its measured height. */
export const DEFAULT_H = 200;
export const COL_GAP = 56;
export const ROW_GAP = 20;
export const PAD = 24;
/** A workspace box reaches this far past its cards, plus a label strip on top. */
export const BOX_PAD = 16;
export const BOX_LABEL = 26;
/** Space between two workspace boxes in the tree layout. */
export const GROUP_GAP = 28;

export interface Point {
  x: number;
  y: number;
}

export interface BoardAgent {
  id: string;
  createdAt: string;
  labels: Record<string, string>;
  workspaceId?: string | null;
}

export interface Edge {
  from: string;
  to: string;
}

/**
 * Default positions as a left-to-right tree: a parent shares its first child's row, each leaf takes a new row.
 * A row is as tall as its tallest card, so cards of different heights do not overlap.
 * Grouped, the trees of one workspace (by their root's workspace) are stacked together, with room for a box around them.
 */
export function treeLayout(
  agents: readonly BoardAgent[],
  heights: Readonly<Record<string, number>> = {},
  grouped = false,
): { positions: Record<string, Point>; edges: Edge[]; roots: Record<string, string> } {
  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, BoardAgent[]>();
  const roots: BoardAgent[] = [];
  const byAge = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const agent of byAge) {
    const parent = agent.labels[PARENT_LABEL];
    if (parent && parent !== agent.id && ids.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), agent]);
    } else {
      roots.push(agent);
    }
  }
  const cells = new Map<string, { row: number; depth: number }>();
  /** Each agent's tree, named by its root's id. */
  const rootOf: Record<string, string> = {};
  const edges: Edge[] = [];
  let row = 0;
  const visit = (agent: BoardAgent, depth: number, root: string) => {
    if (cells.has(agent.id)) return; // a parent-label cycle
    cells.set(agent.id, { row, depth });
    rootOf[agent.id] = root;
    const kids = children.get(agent.id) ?? [];
    if (kids.length === 0) row++;
    for (const kid of kids) {
      edges.push({ from: agent.id, to: kid.id });
      visit(kid, depth + 1, root);
    }
  };
  const groupOf = (agent: BoardAgent) => agent.workspaceId ?? "";
  if (grouped) {
    const order = new Map<string, number>();
    for (const root of roots) if (!order.has(groupOf(root))) order.set(groupOf(root), order.size);
    roots.sort((a, b) => order.get(groupOf(a))! - order.get(groupOf(b))!); // stable: oldest first within a workspace
  }
  /** Rows that open a workspace group. */
  const groupStarts = new Set<number>();
  let lastGroup: string | null = null;
  roots.forEach((root) => {
    if (grouped && groupOf(root) !== lastGroup) {
      groupStarts.add(row);
      lastGroup = groupOf(root);
    }
    visit(root, 0, root.id);
  });
  // Agents caught only in a cycle have no root; place them as roots.
  byAge.forEach((agent) => visit(agent, 0, agent.id));
  const rowHeights: number[] = [];
  for (const [id, cell] of cells) rowHeights[cell.row] = Math.max(rowHeights[cell.row] ?? 0, heights[id] ?? DEFAULT_H);
  const rowTops: number[] = [];
  let top = PAD;
  for (let r = 0; r < rowHeights.length; r++) {
    if (groupStarts.has(r)) top += r === 0 ? BOX_PAD + BOX_LABEL : 2 * BOX_PAD + BOX_LABEL + GROUP_GAP - ROW_GAP;
    rowTops[r] = top;
    top += (rowHeights[r] ?? DEFAULT_H) + ROW_GAP;
  }
  const positions: Record<string, Point> = {};
  for (const [id, cell] of cells) positions[id] = { x: PAD + cell.depth * (CARD_W + COL_GAP), y: rowTops[cell.row] };
  return { positions, edges, roots: rootOf };
}

export interface Box {
  workspaceId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One box per workspace around its cards, wherever they were dragged, in first-seen order. */
export function groupBoxes(cards: readonly (Point & { workspaceId: string; height: number })[]): Box[] {
  const extents = new Map<string, { left: number; top: number; right: number; bottom: number }>();
  for (const card of cards) {
    const e = extents.get(card.workspaceId);
    const right = card.x + CARD_W;
    const bottom = card.y + card.height;
    extents.set(
      card.workspaceId,
      e
        ? { left: Math.min(e.left, card.x), top: Math.min(e.top, card.y), right: Math.max(e.right, right), bottom: Math.max(e.bottom, bottom) }
        : { left: card.x, top: card.y, right, bottom },
    );
  }
  return [...extents].map(([workspaceId, e]) => ({
    workspaceId,
    left: e.left - BOX_PAD,
    top: e.top - BOX_PAD - BOX_LABEL,
    width: e.right - e.left + 2 * BOX_PAD,
    height: e.bottom - e.top + 2 * BOX_PAD + BOX_LABEL,
  }));
}

/** A stable index into `size` colors for a workspace id, so a box keeps its color when boxes reorder. */
export function colorIndex(id: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
  return hash % size;
}

export type ArrowDirection = "right" | "left" | "down" | "up";

/**
 * An elbow arrow from a parent card to its child, as four points and the arrowhead.
 * Side by side (no horizontal overlap), it leaves the parent's facing side at its vertical middle and enters the child's;
 * otherwise it leaves the parent's bottom (or top) center and enters the child's top (or bottom) center.
 * The line stops `head` short of the child, where the arrowhead's tip touches it; `button` is the middle of the middle leg.
 */
export function arrowPath(from: Point, fromHeight: number, to: Point, toHeight: number, head: number) {
  let points: [Point, Point, Point, Point];
  let tip: Point;
  let direction: ArrowDirection;
  if (to.x >= from.x + CARD_W || to.x + CARD_W <= from.x) {
    const right = to.x >= from.x + CARD_W;
    const x1 = right ? from.x + CARD_W : from.x;
    const y1 = from.y + fromHeight / 2;
    tip = { x: right ? to.x : to.x + CARD_W, y: to.y + toHeight / 2 };
    const x2 = right ? tip.x - head : tip.x + head;
    const mx = (x1 + x2) / 2;
    points = [{ x: x1, y: y1 }, { x: mx, y: y1 }, { x: mx, y: tip.y }, { x: x2, y: tip.y }];
    direction = right ? "right" : "left";
  } else {
    const down = to.y + toHeight / 2 >= from.y + fromHeight / 2;
    const x1 = from.x + CARD_W / 2;
    const y1 = down ? from.y + fromHeight : from.y;
    tip = { x: to.x + CARD_W / 2, y: down ? to.y : to.y + toHeight };
    const y2 = down ? tip.y - head : tip.y + head;
    const my = (y1 + y2) / 2;
    points = [{ x: x1, y: y1 }, { x: x1, y: my }, { x: tip.x, y: my }, { x: tip.x, y: y2 }];
    direction = down ? "down" : "up";
  }
  const button = { x: (points[1].x + points[2].x) / 2, y: (points[1].y + points[2].y) / 2 };
  return { points, tip, direction, button };
}

export const GRID = 20;
export const SNAP_DISTANCE = 32;

/**
 * Where a Shift-dragged card lands: each axis snaps to the nearest edge alignment with another card
 * (same left or top, or one tree gap beside, above or below it) within SNAP_DISTANCE, else to the grid.
 */
export function snapPoint(point: Point, height: number, others: readonly (Point & { height: number })[]): Point {
  const axis = (value: number, targets: number[]) => {
    let best = Math.round(value / GRID) * GRID;
    let distance = SNAP_DISTANCE;
    for (const target of targets) {
      const d = Math.abs(target - value);
      if (d < distance) {
        best = target;
        distance = d;
      }
    }
    return Math.max(0, best);
  };
  const step = CARD_W + COL_GAP;
  return {
    x: axis(point.x, others.flatMap((o) => [o.x, o.x + step, o.x - step])),
    y: axis(point.y, others.flatMap((o) => [o.y, o.y + o.height + ROW_GAP, o.y - height - ROW_GAP])),
  };
}

const MAX_ITEMS = 200;

/** Appends a live timeline item, merging streamed text chunks and later states of the same tool call. */
export function pushItem(items: readonly AgentTimelineItem[], item: AgentTimelineItem): AgentTimelineItem[] {
  const last = items[items.length - 1];
  if (last && (item.type === "assistant_message" || item.type === "reasoning") && last.type === item.type) {
    return [...items.slice(0, -1), { ...last, text: last.text + item.text }];
  }
  if (item.type === "tool_call") {
    for (let i = items.length - 1; i >= 0; i--) {
      const old = items[i];
      if (old.type === "tool_call" && old.callId === item.callId) {
        return [...items.slice(0, i), item, ...items.slice(i + 1)];
      }
    }
  }
  return [...items, item].slice(-MAX_ITEMS);
}

const MAX_TEXT = 1000;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}

/** Words for tool calls and states on a card, in the reader's language. */
export interface ActivityWords {
  read: string;
  edit: string;
  write: string;
  search: string;
  fetch: string;
  subAgent: string;
  failed: string;
  thinking: string;
  error: string;
}

export const ENGLISH_WORDS: ActivityWords = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  search: "Search",
  fetch: "Fetch",
  subAgent: "Subagent",
  failed: "failed",
  thinking: "Thinking",
  error: "Error",
};

function toolLabel(item: Extract<AgentTimelineItem, { type: "tool_call" }>, words: ActivityWords): string {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return `$ ${oneLine(detail.command)}`;
    case "read":
      return `${words.read} ${shortPath(detail.filePath)}`;
    case "edit":
      return `${words.edit} ${shortPath(detail.filePath)}`;
    case "write":
      return `${words.write} ${shortPath(detail.filePath)}`;
    case "search":
      return `${words.search} ${oneLine(detail.query)}`;
    case "fetch":
      return `${words.fetch} ${detail.url}`;
    case "sub_agent":
      return `${words.subAgent}${detail.subAgentType ? ` ${detail.subAgentType}` : ""}${detail.description ? `: ${oneLine(detail.description)}` : ""}`;
    case "plain_text":
      return oneLine(detail.label ?? detail.text ?? item.name);
    default:
      return item.name;
  }
}

/**
 * A prompt the agent was given: the user's message, or a message another agent sent it, which Paseo records as an
 * `agent_message` tool call carrying the sender. `from` is the sending agent's id, null for the user.
 */
export function promptOf(item: AgentTimelineItem): { text: string; from: string | null } | null {
  if (item.type === "user_message") return { text: item.text, from: null };
  if (item.type === "tool_call" && item.agentMessage?.event === "message") return { text: item.agentMessage.text, from: item.agentMessage.sender.id };
  return null;
}

const TRANSCRIPT_CHARS = 6000;

/** The newest activity as short labelled lines for the summarizer, oldest first, within a character budget; in English whatever the UI language. */
export function transcript(items: readonly AgentTimelineItem[]): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = items.length - 1; i >= 0 && size < TRANSCRIPT_CHARS; i--) {
    const item = items[i];
    let line: string | null = null;
    const given = promptOf(item);
    if (given) line = `${given.from ? "Instruction" : "User"}: ${oneLine(given.text).slice(0, 400)}`;
    else if (item.type === "assistant_message") line = `Agent: ${oneLine(item.text).slice(0, 300)}`;
    else if (item.type === "tool_call") line = `Tool: ${toolLabel(item, ENGLISH_WORDS).slice(0, 200)}`;
    else if (item.type === "todo")
      line = `Todo: ${item.items.map((todo) => `[${todo.completed ? "done" : todo.status === "in_progress" ? "in progress" : "pending"}] ${todo.text}`).join(" / ")}`;
    else if (item.type === "error") line = `Error: ${oneLine(item.message).slice(0, 200)}`;
    if (line) {
      lines.push(line);
      size += line.length;
    }
  }
  return lines.reverse().join("\n");
}

export interface Activity {
  /** The latest prompt the agent was given. */
  task: string | null;
  /** The latest tool call, answer, or thought of that turn. */
  latest: string | null;
  /** The in-progress step of the latest todo list, as "n/m text". */
  step: string | null;
  /** The latest turn started compacting its context and has not finished. */
  compacting: boolean;
}

export function describeActivity(items: readonly AgentTimelineItem[], words: ActivityWords): Activity {
  let task: string | null = null;
  let latest: string | null = null;
  let step: string | null = null;
  let compacting: boolean | null = null;
  for (let i = items.length - 1; i >= 0 && (task === null || step === null); i--) {
    const item = items[i];
    // Claude marks the start and the end of a compaction with separate items; the newer one of the turn tells.
    if (item.type === "compaction") {
      if (task === null) compacting ??= item.status === "loading";
      continue;
    }
    const given = promptOf(item);
    if (given) {
      task ??= oneLine(given.text);
      continue;
    }
    if (item.type === "todo" && step === null) {
      const current = item.items.find((todo) => todo.status === "in_progress") ?? item.items.find((todo) => !todo.completed);
      const done = item.items.filter((todo) => todo.completed).length;
      step = current ? `${done + 1}/${item.items.length} ${oneLine(current.activeForm ?? current.text)}` : "";
    }
    // Only the turn of the latest prompt counts as what the agent is doing.
    if (latest !== null || task !== null) continue;
    if (item.type === "tool_call") latest = toolLabel(item, words) + (item.status === "failed" ? ` (${words.failed})` : "");
    else if (item.type === "assistant_message") latest = oneLine(item.text);
    else if (item.type === "reasoning") latest = words.thinking;
    else if (item.type === "error") latest = `${words.error}: ${oneLine(item.message)}`;
  }
  return { task, latest: latest || null, step: step || null, compacting: compacting ?? false };
}

/** The fields of a Paseo agent profile the board matches agents against. */
export interface ProfileLike {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

const bareModel = (model: string) => model.split("/").pop() ?? model;

/**
 * The profile an agent was most likely started from. Paseo does not record it on the agent, so a profile matches when its
 * provider and every setting it fixes equal the agent's current ones; the profile fixing the most settings wins.
 * shortcut: an agent set up by hand like a profile shows that profile, and one whose mode or effort changed later shows none;
 * use a recorded profile id once Paseo stores one.
 */
export function profileOf<P extends ProfileLike>(
  agent: { provider: string; model: string | null; modeId: string | null; thinkingOptionId: string | null },
  profiles: readonly P[],
): P | null {
  let best: P | null = null;
  let bestFixed = -1;
  for (const profile of profiles) {
    if (profile.provider !== agent.provider) continue;
    if (profile.model && (!agent.model || bareModel(profile.model) !== bareModel(agent.model))) continue;
    if (profile.modeId && profile.modeId !== agent.modeId) continue;
    if (profile.thinkingOptionId && profile.thinkingOptionId !== agent.thinkingOptionId) continue;
    const fixed = [profile.model, profile.modeId, profile.thinkingOptionId].filter(Boolean).length;
    if (fixed > bestFixed) {
      best = profile;
      bestFixed = fixed;
    }
  }
  return best;
}

/** Parent and children links among `agents` by the parent label, ignoring parents outside the set. */
function links(agents: readonly BoardAgent[]) {
  const ids = new Set(agents.map((a) => a.id));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const agent of agents) {
    const parent = agent.labels[PARENT_LABEL];
    if (!parent || parent === agent.id || !ids.has(parent)) continue;
    parentOf.set(agent.id, parent);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), agent.id]);
  }
  return { parentOf, childrenOf };
}

/** The given agents and all their descendants. */
export function subtrees(agents: readonly BoardAgent[], ids: Iterable<string>): Set<string> {
  const { childrenOf } = links(agents);
  const found = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (found.has(id)) continue; // a parent-label cycle
    found.add(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return found;
}

/** The agent with its ancestors and its descendants. */
export function lineage(agents: readonly BoardAgent[], id: string): Set<string> {
  const { parentOf } = links(agents);
  const found = subtrees(agents, [id]);
  for (let parent = parentOf.get(id); parent !== undefined && !found.has(parent); parent = parentOf.get(parent)) found.add(parent);
  return found;
}
