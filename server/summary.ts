import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { transcript } from "../shared/board";
import { createHash } from "node:crypto";
import type { agentSummary, instructionSummary, SummaryModel } from "../shared/summary";

type Summary = RpcOutput<typeof agentSummary>;
type InstructionSummary = RpcOutput<typeof instructionSummary>;

/** A running agent is summarized at most this often; an idle one only when its timeline changes. */
const RUNNING_INTERVAL = 60_000;
const MAX_PARALLEL = 2;
const SCHEMA = JSON.stringify({
  type: "object",
  properties: { title: { type: "string" }, doing: { type: "string" } },
  required: ["title", "doing"],
  additionalProperties: false,
});
const INSTRUCTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: { goal: { type: "string" }, points: { type: "array", items: { type: "string" }, maxItems: 5 } },
  required: ["goal", "points"],
  additionalProperties: false,
});
/** Longer instructions are summarized from their start; the box still shows the whole original. */
const INSTRUCTION_CHARS = 8000;

const cache = new Map<string, { key: string; at: number; result: Summary }>();
const inflight = new Map<string, Promise<Summary>>();
const children = new Set<ChildProcess>();
let active = 0;
let stopped = false;
const waiting: Array<() => void> = [];

async function limited<T>(run: () => Promise<T>): Promise<T> {
  while (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const names = new Intl.DisplayNames(["en"], { type: "language" });

/** The app language as a canonical tag and an English name; CJK gets half the character budget. */
function language(locale: string) {
  let tag = "en";
  try {
    tag = Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {}
  return { tag, name: names.of(tag) ?? "English", dense: /^(ko|ja|zh)\b/.test(tag) };
}

type Language = ReturnType<typeof language>;

/** The language line, and for Korean the noun-ending style the board was first written in. */
const style = ({ tag, name }: Language) => [
  ...(/^ko\b/.test(tag) ? ['End each value with a noun form, like "타입 오류 수정 중" or "로그인 테스트 완료".'] : []),
  `Write every value in ${name}.`,
];

function prompt(title: string | null, running: boolean, log: string, lang: Language): string {
  return [
    "Read a coding agent's recent activity log and answer in JSON.",
    `- title: the job the agent took on in this session, as a noun phrase of at most ${lang.dense ? 20 : 40} characters.`,
    `- doing: what the agent ${running ? "is actually doing" : "did last"} at the end of the log, as a short phrase of at most ${lang.dense ? 30 : 60} characters including spaces. Leave out file paths and commands, and describe the agent's action instead of restating the user's request.`,
    ...style(lang),
    `Session name (start of the first request): ${title ?? "none"}`,
    `State: ${running ? "running" : "stopped"}`,
    "Log:",
    log,
  ].join("\n");
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

function instructionPrompt(text: string, lang: Language): string {
  const limit = lang.dense ? 40 : 80;
  return [
    "Read a work instruction one agent sent another and summarize it in JSON so a person can take it in quickly.",
    `- goal: the purpose of the instruction, at most ${limit} characters including spaces.`,
    `- points: the main requirements and constraints in the instruction, at most 5, each at most ${limit} characters including spaces. Do not add anything the instruction does not say.`,
    ...style(lang),
    "Instruction:",
    text.slice(0, INSTRUCTION_CHARS),
  ].join("\n");
}

/** Runs one summary CLI from a temporary folder (keeping project CLAUDE.md and AGENTS.md files out), with the prompt on stdin. */
function run(command: string, args: string[], text: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    if (stopped) return reject(new Error("plugin stopping"));
    const child = spawn(command, args, {
      cwd: tmpdir(),
      env: { ...process.env, PATH: [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":") },
      timeout: 60_000,
    });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      children.delete(child);
      resolve({ code, out, err });
    });
    child.stdin.end(text);
  });
}

/** One Claude Haiku call through the local Claude Code CLI, without tools, settings, MCP servers or a saved session. */
async function askClaude(text: string, schema: string): Promise<Record<string, unknown>> {
  const { code, out, err } = await run(
    "claude",
    ["-p", "--model", "haiku", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands",
      "--setting-sources", "", "--output-format", "json", "--json-schema", schema],
    text,
  );
  try {
    const parsed = JSON.parse(out);
    const value = parsed.structured_output;
    if (code !== 0 || parsed.is_error || !value) throw new Error(String(parsed.result ?? `exit ${code}`));
    return value;
  } catch (error) {
    throw new Error(`claude summary failed: ${error instanceof Error ? error.message : error} ${err.slice(0, 300)}`);
  }
}

/** One GPT-6-Luna call through the local Codex CLI: read-only sandbox, no saved session, without the user's config (MCP servers, profiles) or rules. */
async function askCodex(text: string, schema: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "agent-board-"));
  try {
    const schemaFile = join(dir, "schema.json");
    const answerFile = join(dir, "answer.json");
    await writeFile(schemaFile, schema);
    const { code, err } = await run(
      "codex",
      ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
        "--model", "gpt-6-luna", "-c", "model_reasoning_effort=low", "--output-schema", schemaFile, "--output-last-message", answerFile, "-"],
      text,
    );
    // Codex prints its errors (sign-in, usage limit) to stderr and still writes no answer file.
    if (code !== 0) throw new Error(`exit ${code} ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    return JSON.parse(await readFile(answerFile, "utf8"));
  } catch (error) {
    throw new Error(`codex summary failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ask = (model: SummaryModel, text: string, schema: string) => (model === "codex" ? askCodex : askClaude)(text, schema);

export async function summarize(
  { agentId, running, locale, model }: RpcInput<typeof agentSummary>,
  { paseo }: PluginHandlerContext,
): Promise<Summary> {
  const lang = language(locale);
  const id = `${agentId}\0${lang.tag}\0${model}`;
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 150 });
  const key = String(page.entries.at(-1)?.seqEnd ?? 0);
  const hit = cache.get(id);
  if (hit && (hit.key === key || (running && Date.now() - hit.at < RUNNING_INTERVAL))) return hit.result;
  const pending = inflight.get(id);
  if (pending) return pending;
  const job = limited(async () => {
    const log = transcript(page.entries.map((entry) => entry.item));
    let result: Summary = { title: null, doing: null };
    if (log) {
      try {
        const value = await ask(model, prompt(page.agent?.title ?? null, running, log, lang), SCHEMA);
        result = { title: clean(value.title, 40), doing: clean(value.doing, 60) };
      } catch (error) {
        if (!stopped) console.error(`[agent-board] ${agentId}:`, error instanceof Error ? error.message : error);
      }
    }
    // Failures are cached too, so a broken CLI is retried only when the timeline changes or a minute passes.
    cache.set(id, { key, at: Date.now(), result });
    return result;
  }).finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

const instructions = new Map<string, Promise<InstructionSummary>>();

/** Summarizes an instruction once per distinct text, language and model while the plugin runs; a failed call is retried on the next request. */
export function summarizeInstruction({ text, locale, model }: RpcInput<typeof instructionSummary>): Promise<InstructionSummary> {
  const lang = language(locale);
  const key = createHash("sha256").update(`${model}\0${lang.tag}\0${text}`).digest("hex");
  const known = instructions.get(key);
  if (known) return known;
  const job = limited(async () => {
    const value = await ask(model, instructionPrompt(text, lang), INSTRUCTION_SCHEMA);
    const points = Array.isArray(value.points) ? value.points.map((point) => clean(point, 80)).filter((point): point is string => point !== null) : [];
    return { goal: clean(value.goal, 80), points: points.slice(0, 5) };
  });
  instructions.set(key, job);
  job.catch((error) => {
    instructions.delete(key);
    if (!stopped) console.error("[agent-board] instruction:", error instanceof Error ? error.message : error);
  });
  return job;
}

/**
 * Ends running summary calls and waits for their requests to answer before the plugin stops;
 * an answer sent after the IPC channel closes crashes the plugin process.
 */
export async function stopSummaries(): Promise<void> {
  stopped = true;
  for (const child of children) child.kill();
  waiting.splice(0).forEach((wake) => wake());
  await Promise.allSettled([...inflight.values(), ...instructions.values()]);
}
