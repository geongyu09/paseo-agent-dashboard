import assert from "node:assert/strict";
import { test } from "node:test";
import { findSvgIconProblem } from "@getpaseo/plugin";
import { CLAUDE_SVG, OPENAI_SVG } from "./icons.ts";
import { CARD_W, DEFAULT_H, COL_GAP, ENGLISH_WORDS, PAD, PARENT_LABEL, ROW_GAP, BOX_LABEL, BOX_PAD, arrowPath, GRID, GROUP_GAP, SNAP_DISTANCE, colorIndex, groupBoxes, describeActivity, lineage, profileOf, promptOf, pushItem, subtrees, snapPoint, transcript, treeLayout } from "./board.ts";
import { GHOSTTY, nodeColors } from "../client/look.ts";

const agent = (id, createdAt, parent) => ({ id, createdAt, labels: parent ? { [PARENT_LABEL]: parent } : {} });

test("treeLayout puts a parent on its first child's row and each leaf on a new row", () => {
  const { positions, edges, roots } = treeLayout([
    agent("orch", "1"),
    agent("b", "3", "orch"),
    agent("a", "2", "orch"),
    agent("solo", "4"),
    agent("orphan", "5", "missing"),
  ]);
  const col = (n) => PAD + n * (CARD_W + COL_GAP);
  const row = (n) => PAD + n * (DEFAULT_H + ROW_GAP);
  assert.deepEqual(positions.orch, { x: col(0), y: row(0) });
  assert.deepEqual(positions.a, { x: col(1), y: row(0) });
  assert.deepEqual(positions.b, { x: col(1), y: row(1) });
  assert.deepEqual(positions.solo, { x: col(0), y: row(2) });
  assert.deepEqual(positions.orphan, { x: col(0), y: row(3) });
  assert.deepEqual(edges, [{ from: "orch", to: "a" }, { from: "orch", to: "b" }]);
  assert.deepEqual(roots, { orch: "orch", a: "orch", b: "orch", solo: "solo", orphan: "orphan" });
});

test("treeLayout makes a row as tall as its tallest measured card", () => {
  const { positions } = treeLayout([agent("orch", "1"), agent("a", "2", "orch"), agent("b", "3", "orch")], { orch: 100, a: 400, b: 50 });
  assert.equal(positions.a.y, PAD);
  assert.equal(positions.b.y, PAD + 400 + ROW_GAP);
});

test("treeLayout places agents caught in a parent cycle", () => {
  const { positions } = treeLayout([agent("x", "1", "y"), agent("y", "2", "x")]);
  assert.ok(positions.x && positions.y);
});

test("pushItem merges streamed text and later states of a tool call", () => {
  const running = { type: "tool_call", callId: "c1", name: "Bash", status: "running", error: null, detail: { type: "shell", command: "npm test" } };
  let items = pushItem([], { type: "assistant_message", text: "Hel" });
  items = pushItem(items, { type: "assistant_message", text: "lo" });
  items = pushItem(items, running);
  items = pushItem(items, { ...running, status: "completed" });
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "Hello");
  assert.equal(items[1].status, "completed");
});

test("describeActivity reads the latest prompt, the latest action of its turn, and the todo step", () => {
  const activity = describeActivity([
    { type: "user_message", text: "old task" },
    { type: "assistant_message", text: "old answer" },
    { type: "user_message", text: "  Fix the\nlogin bug " },
    { type: "todo", items: [
      { text: "Read code", completed: true, status: "completed" },
      { text: "Fix", completed: false, status: "in_progress", activeForm: "Fixing redirect" },
      { text: "Test", completed: false, status: "pending" },
    ] },
    { type: "tool_call", callId: "c1", name: "Edit", status: "running", error: null, detail: { type: "edit", filePath: "/repo/src/auth/login.ts" } },
  ], ENGLISH_WORDS);
  assert.deepEqual(activity, { task: "Fix the login bug", latest: "Edit auth/login.ts", step: "2/3 Fixing redirect", compacting: false });
});

test("describeActivity ignores actions from before the latest prompt", () => {
  const activity = describeActivity([
    { type: "assistant_message", text: "old answer" },
    { type: "user_message", text: "new task" },
  ], ENGLISH_WORDS);
  assert.deepEqual(activity, { task: "new task", latest: null, step: null, compacting: false });
});

test("describeActivity reports a compaction until its completed marker, within the latest turn", () => {
  const prompt = { type: "user_message", text: "task" };
  const loading = { type: "compaction", status: "loading" };
  const done = { type: "compaction", status: "completed", trigger: "auto" };
  assert.equal(describeActivity([prompt, loading], ENGLISH_WORDS).compacting, true);
  assert.equal(describeActivity([prompt, loading, done], ENGLISH_WORDS).compacting, false);
  assert.equal(describeActivity([loading, prompt], ENGLISH_WORDS).compacting, false);
});

test("describeActivity writes tool calls, failures, thoughts and errors in the given words", () => {
  const words = { ...ENGLISH_WORDS, read: "읽기", failed: "실패", thinking: "생각 중", error: "오류" };
  const prompt = { type: "user_message", text: "task" };
  const read = { type: "tool_call", callId: "c1", name: "Read", status: "failed", error: null, detail: { type: "read", filePath: "/repo/a.ts" } };
  assert.equal(describeActivity([prompt, read], words).latest, "읽기 repo/a.ts (실패)");
  assert.equal(describeActivity([prompt, { type: "reasoning", text: "hm" }], words).latest, "생각 중");
  assert.equal(describeActivity([prompt, { type: "error", message: "boom" }], words).latest, "오류: boom");
});

test("transcript labels user, agent, tool and todo lines and skips thoughts", () => {
  const log = transcript([
    { type: "user_message", text: "Fix\nlogin" },
    { type: "reasoning", text: "thinking" },
    { type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test" } },
    { type: "todo", items: [{ text: "Fix", completed: false, status: "in_progress" }] },
    { type: "assistant_message", text: "Done" },
  ]);
  assert.equal(log, "User: Fix login\nTool: $ npm test\nTodo: [in progress] Fix\nAgent: Done");
});

test("snapPoint aligns with a nearby card edge, else with the grid", () => {
  const other = { x: 100, y: 100, height: 200 };
  // Near the other card's left edge and one row gap below it.
  assert.deepEqual(snapPoint({ x: 110, y: 100 + 200 + ROW_GAP + 9 }, 150, [other]), { x: 100, y: 100 + 200 + ROW_GAP });
  // One tree column to the right, same top.
  assert.deepEqual(snapPoint({ x: 100 + CARD_W + COL_GAP - 5, y: 95 }, 150, [other]), { x: 100 + CARD_W + COL_GAP, y: 100 });
  // Far from every edge: the grid.
  const far = snapPoint({ x: 1000 + SNAP_DISTANCE + 7, y: 2000 + 3 }, 150, [other]);
  assert.equal(far.x % GRID, 0);
  assert.equal(far.y % GRID, 0);
  assert.deepEqual(snapPoint({ x: -40, y: -40 }, 150, []), { x: 0, y: 0 });
});

test("the Claude icon passes Paseo's inline SVG check", () => {
  assert.equal(findSvgIconProblem(CLAUDE_SVG), null);
  assert.equal(findSvgIconProblem(OPENAI_SVG), null);
});

test("grouped treeLayout stacks each workspace's trees together with room for its box", () => {
  const w = (id, createdAt, workspaceId, parent) => ({ ...agent(id, createdAt, parent), workspaceId });
  const { positions } = treeLayout([w("a1", "1", "A"), w("b1", "2", "B"), w("a2", "3", "A"), w("a2kid", "4", "B", "a2")], {}, true);
  const first = PAD + BOX_PAD + BOX_LABEL;
  assert.equal(positions.a1.y, first);
  assert.equal(positions.a2.y, first + DEFAULT_H + ROW_GAP);
  assert.equal(positions.a2kid.y, positions.a2.y); // a child stays with its root's workspace group
  assert.equal(positions.b1.y, positions.a2.y + DEFAULT_H + 2 * BOX_PAD + BOX_LABEL + GROUP_GAP);
  const boxes = groupBoxes([
    { workspaceId: "A", x: 24, y: 66, height: 100 },
    { workspaceId: "A", x: 420, y: 300, height: 50 },
  ]);
  assert.deepEqual(boxes, [{ workspaceId: "A", left: 24 - BOX_PAD, top: 66 - BOX_PAD - BOX_LABEL, width: 420 + CARD_W - 24 + 2 * BOX_PAD, height: 350 - 66 + 2 * BOX_PAD + BOX_LABEL }]);
});

test("a workspace box keeps its color when the box order changes", () => {
  const cards = ["ws-a", "ws-b", "ws-c"].map((workspaceId, i) => ({ workspaceId, x: 0, y: i * 200, height: 100 }));
  const colors = (list) => groupBoxes(list).map((box) => [box.workspaceId, colorIndex(box.workspaceId, 6)]);
  const forward = colors(cards);
  const backward = colors([...cards].reverse());
  assert.notDeepEqual(forward, backward); // the boxes did reorder
  assert.deepEqual(Object.fromEntries(forward), Object.fromEntries(backward));
  for (const [, index] of forward) assert.ok(Number.isInteger(index) && index >= 0 && index < 6);
});

test("arrowPath joins facing sides side by side, and bottom center to top center when stacked", () => {
  const side = arrowPath({ x: 0, y: 0 }, 100, { x: CARD_W + 60, y: 300 }, 200, 9);
  assert.equal(side.direction, "right");
  assert.deepEqual(side.points[0], { x: CARD_W, y: 50 });
  assert.deepEqual(side.tip, { x: CARD_W + 60, y: 400 });
  const below = arrowPath({ x: 0, y: 0 }, 100, { x: 40, y: 300 }, 200, 9);
  assert.equal(below.direction, "down");
  assert.deepEqual(below.points[0], { x: CARD_W / 2, y: 100 });
  assert.deepEqual(below.tip, { x: 40 + CARD_W / 2, y: 300 });
  assert.equal(below.points[3].y, 300 - 9);
  const above = arrowPath({ x: 0, y: 500 }, 100, { x: 0, y: 0 }, 200, 9);
  assert.equal(above.direction, "up");
  assert.deepEqual(above.points[0], { x: CARD_W / 2, y: 500 });
  assert.deepEqual(above.tip, { x: CARD_W / 2, y: 200 });
});

test("profileOf matches the provider and every fixed setting, preferring the most specific profile", () => {
  const writer = { name: "writer", provider: "codex", model: "gpt-6.1-sol", modeId: "full-access", thinkingOptionId: "xhigh" };
  const anyClaude = { name: "any claude", provider: "claude" };
  const opus = { name: "opus", provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "xhigh" };
  const profiles = [writer, anyClaude, opus];
  const agent = (provider, model, modeId, thinkingOptionId) => ({ provider, model, modeId, thinkingOptionId });
  assert.equal(profileOf(agent("codex", "gpt-6.1-sol", "full-access", "xhigh"), profiles), writer);
  assert.equal(profileOf(agent("codex", "gpt-6.1-sol", "auto", "xhigh"), profiles), null);
  assert.equal(profileOf(agent("claude", "claude/claude-opus-5-5", "bypassPermissions", "xhigh"), profiles), opus);
  assert.equal(profileOf(agent("claude", "claude-haiku-5-5", "default", null), profiles), anyClaude);
});

test("promptOf reads user messages and messages sent by another agent, and describeActivity treats both as the task", () => {
  const sent = {
    type: "tool_call", callId: "paseo-agent-message:1", name: "agent_message", status: "completed", error: null,
    agentMessage: { event: "message", sender: { id: "parent-1", title: "부모" }, text: "커밋을 조사합니다" },
    detail: { type: "plain_text", text: "커밋을 조사합니다" },
  };
  const finished = { ...sent, agentMessage: { ...sent.agentMessage, event: "finished" } };
  assert.deepEqual(promptOf(sent), { text: "커밋을 조사합니다", from: "parent-1" });
  assert.deepEqual(promptOf({ type: "user_message", text: "hi" }), { text: "hi", from: null });
  assert.equal(promptOf(finished), null);
  assert.equal(describeActivity([sent], ENGLISH_WORDS).task, "커밋을 조사합니다");
  assert.equal(transcript([sent]), "Instruction: 커밋을 조사합니다");
});

test("lineage takes ancestors and descendants, and subtrees take descendants only", () => {
  const agent = (id, parent) => ({ id, createdAt: "", labels: parent ? { [PARENT_LABEL]: parent } : {} });
  // root -> a -> a1, root -> b; loop1 <-> loop2 is a parent-label cycle
  const agents = [agent("root"), agent("a", "root"), agent("a1", "a"), agent("b", "root"), agent("loop1", "loop2"), agent("loop2", "loop1")];
  assert.deepEqual([...lineage(agents, "a")].sort(), ["a", "a1", "root"]);
  assert.deepEqual([...subtrees(agents, ["a"])].sort(), ["a", "a1"]);
  assert.deepEqual([...subtrees(agents, ["root"])].sort(), ["a", "a1", "b", "root"]);
  assert.deepEqual([...lineage(agents, "loop1")].sort(), ["loop1", "loop2"]);
});

test("nodeColors keeps Ghostty's card colors on light themes and the theme's on dark or non-hex ones", () => {
  const theme = (surface0) => ({ ...GHOSTTY, surface0 });
  assert.equal(nodeColors(theme("#ffffff")), GHOSTTY);
  const dark = theme("#18181b");
  assert.equal(nodeColors(dark), dark);
  const named = theme("white");
  assert.equal(nodeColors(named), named);
});
