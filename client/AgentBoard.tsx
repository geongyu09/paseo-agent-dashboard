import { usePaseo, useRpc, useSettings, useTabState, useTranslation, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
// @getpaseo/client is not installed with the plugin; the host only resolves type imports from @getpaseo/protocol/*.
import type { AgentSnapshotPayload as PaseoAgent, WorkspaceDescriptorPayload as PaseoWorkspace } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, Easing, PanResponder, Platform, Pressable, ScrollView, Text, View, type GestureResponderEvent, type TextStyle } from "react-native";
import { BOX_LABEL, BOX_PAD, CARD_W, DEFAULT_H, PAD, arrowPath, type ArrowDirection, type Box, colorIndex, describeActivity, groupBoxes, lineage, profileOf, promptOf, pushItem, subtrees, snapPoint, treeLayout, type Point, type ProfileLike } from "../shared/board";
import { CLAUDE_SVG, OPENAI_SVG } from "../shared/icons";
import { boardLayout } from "../shared/layout";
import { workspaceLabels } from "../shared/labels";
import { agentSummary, instructionSummary } from "../shared/summary";
import type { RpcOutput } from "@getpaseo/plugin";
import { AMBER, BLUE, GRAY, GREEN, ORANGE, RED, PROVIDER_COLORS, PURPLE, effortColor, identityColor, modeColor, nodeColors, tint } from "./look";
import { messages } from "./messages";
import { listenForUndo, listenForWheel } from "./web";
import { z } from "zod";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];
/** Movement below this many pixels is a tap that opens the agent. */
const TAP_SLOP = 4;
const LINE_H = 17;
/** The daemon summarizes a running agent at most once a minute, so polling faster gains nothing. */
const SUMMARY_POLL = 60_000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const ARROW = 9;
/** Lines are 2px; this is their pressable thickness. */
const HIT = 12;
const FLOW_DOTS = [0, 1 / 3, 2 / 3];
/** Ended agents are shown, when asked, only if they ended within this window; older ones would bury the live graphs. */
const ENDED_WINDOW = 24 * 60 * 60 * 1000;
const UNDO_DEPTH = 50;
const DIM = 0.18;

/**
 * Per-tab view: whether ended agents show, the highlighted agent (shown with its ancestors and descendants) and the
 * hidden agents (each hidden with its descendants). Tabs saved when these named graph roots keep working: a root's
 * lineage and subtree are its whole graph.
 */
const viewSchema = z.object({
  showClosed: z.boolean(),
  focus: z.string().nullable(),
  hidden: z.array(z.string()),
  /** Group graphs by workspace; defaulted so tabs saved before it keep their other settings. */
  group: z.boolean().default(true),
});
const DEFAULT_VIEW: z.infer<typeof viewSchema> = { showClosed: false, focus: null, hidden: [], group: true };
const BOX_COLORS = [BLUE, GREEN, "#a371f7", ORANGE, "#db61a2", "#39c5cf"];

const ended = (agent: PaseoAgent) => Boolean(agent.archivedAt) || agent.status === "closed";

interface WorkspaceInfo {
  projectId: string | null;
  name: string;
  labels: string[];
}

const workspaceInfo = (w: PaseoWorkspace): WorkspaceInfo => ({ projectId: w.projectId ?? null, name: w.title || w.name, labels: w.labels ?? [] });

type Profile = ProfileLike & { name: string; icon?: string; color?: string };

/** The host's agent profiles, from its config; re-read now and then because profiles change outside the board. */
function useProfiles(): Profile[] {
  const paseo = usePaseo();
  const query = useQuery({
    queryKey: ["agent-board", "profiles"],
    queryFn: async () => ((await paseo.config.get()).config.agentProfiles ?? []) as Profile[],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  return query.data ?? NO_PROFILES;
}
const NO_PROFILES: Profile[] = [];

/** Label name → its Paseo color name, refetched when the board sees a label it has no color for. */
function useLabelColors(names: string[]): Map<string, string> {
  const readLabels = useRpc(workspaceLabels);
  const query = useQuery({
    queryKey: ["agent-board", "labels", [...new Set(names)].sort()],
    queryFn: () => readLabels({}),
    enabled: names.length > 0,
    placeholderData: keepPreviousData,
  });
  return useMemo(() => new Map(query.data?.labels.map((label) => [label.name, label.color])), [query.data]);
}

/** Paseo profile icon keys are Lucide icon names in camel case; only the flask differs. */
const profileIcon = (key: string) => (key === "flask" ? "FlaskConical" : key.charAt(0).toUpperCase() + key.slice(1));

/** Agents and workspace → project ids, kept live by owned list subscriptions. */
function useLiveLists(includeArchived: boolean) {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<Map<string, PaseoAgent>>(new Map());
  /** Workspace id → its project, display name and label names. */
  const [workspaces, setWorkspaces] = useState<Map<string, WorkspaceInfo>>(new Map());
  useEffect(() => {
    const lifetime = new AbortController();
    const releases: Array<() => void> = [];
    const own = (subscription: { release(): Promise<void> }) => {
      if (lifetime.signal.aborted) void subscription.release();
      else releases.push(() => void subscription.release());
    };
    paseo.agents
      .list(
        includeArchived
          ? { subscribe: {}, signal: lifetime.signal, filter: { includeArchived: true }, sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 200 } }
          : { subscribe: {}, signal: lifetime.signal },
      )
      .then(({ subscription }) => {
        own(subscription);
        subscription.subscribe({
          snapshot: ({ entries }) => setAgents(new Map(entries.map(({ agent }) => [agent.id, agent]))),
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            setAgents((current) => {
              const next = new Map(current);
              if (update.kind === "upsert") next.set(update.agent.id, update.agent);
              else next.delete(update.agentId);
              return next;
            });
          },
        });
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) console.error("[agent-board] agent list failed", error);
      });
    paseo.workspaces
      .list({ subscribe: {} })
      .then(({ subscription }) => {
        own(subscription);
        subscription.subscribe({
          snapshot: ({ entries }) => setWorkspaces(new Map(entries.map((w) => [w.id, workspaceInfo(w)]))),
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            setWorkspaces((current) => {
              const next = new Map(current);
              if (update.kind === "upsert")
                next.set(update.workspace.id, workspaceInfo(update.workspace));
              else next.delete(update.id);
              return next;
            });
          },
        });
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) console.error("[agent-board] workspace list failed", error);
      });
    return () => {
      lifetime.abort();
      releases.forEach((release) => release());
    };
  }, [paseo, includeArchived]);
  return { agents, workspaces };
}

/** The agent's recent timeline: one tail page, then live items. */
function useTimeline(agentId: string): AgentTimelineItem[] {
  const paseo = usePaseo();
  const [items, setItems] = useState<AgentTimelineItem[]>([]);
  useEffect(() => {
    const timeline = paseo.agents.ref(agentId).timeline;
    let active = true;
    const load = () =>
      void timeline
        .refetch({ direction: "tail", limit: 200 })
        .then((page) => {
          if (active) setItems(page.entries.map((entry) => entry.item));
        })
        .catch(() => {});
    const unsubscribe = timeline.subscribe((message) => {
      const event = message.event;
      if (event.type === "timeline") setItems((current) => pushItem(current, event.item));
      else if (event.type === "replacement" || event.type === "subscription_restored") load();
    });
    load();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [paseo, agentId]);
  return items;
}

function shortModel(model: string): string {
  return (model.split("/").pop() ?? model).replace(/-\d{8}$/, "").replace(/^claude-/, "");
}

type StatusKey = keyof typeof messages.resources.en.status;

function statusOf(agent: PaseoAgent, colors: Colors, compacting: boolean): { key: StatusKey; color: string } {
  if (agent.archivedAt) return { key: "archived", color: GRAY };
  if (agent.status === "closed") return { key: "closed", color: GRAY };
  if (agent.pendingPermissions.length > 0 || (agent.requiresAttention && agent.attentionReason === "permission"))
    return { key: "permission", color: colors.statusWarning };
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error"))
    return { key: "error", color: colors.statusDanger };
  if (agent.status === "running") return compacting ? { key: "compacting", color: PURPLE } : { key: "running", color: AMBER };
  if (agent.status === "initializing") return { key: "initializing", color: colors.foregroundMuted };
  if (agent.requiresAttention && agent.attentionReason === "finished") return { key: "finished", color: colors.statusSuccess };
  return { key: "idle", color: colors.foregroundMuted };
}

interface DragHandlers {
  move(id: string, dx: number, dy: number, shift: boolean): void;
  drop(id: string, dx: number, dy: number, shift: boolean): void;
  cancel(): void;
  focus(id: string): void;
  hide(id: string): void;
  press(id: string): void;
  measure(id: string, height: number): void;
}

/** React Native Web puts the mouse event's modifier keys on responder events; native touches have none. */
const shiftHeld = (event: GestureResponderEvent) => Boolean((event.nativeEvent as { shiftKey?: boolean }).shiftKey);

const PROVIDER_SVGS: Record<string, string> = { claude: CLAUDE_SVG, codex: OPENAI_SVG };

function ProviderLogo({ provider, svg, colors }: { provider: string; svg?: string; colors: Colors }) {
  const icon = PROVIDER_SVGS[provider] ?? svg;
  return (
    <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
      {icon ? (
        <Icon icon={{ svg: icon }} size={17} color={colors.foreground} />
      ) : (
        <Text selectable={false} style={{ color: PROVIDER_COLORS[provider] ?? colors.foreground, fontSize: 12, fontWeight: "800" }}>
          {provider.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

/** A colored tag: text in the color over a tint of it. */
function Tag({ text, color, label, style }: { text: string; color: string; label?: string; style?: TextStyle }) {
  return (
    <Text
      selectable={false}
      numberOfLines={1}
      accessibilityLabel={label}
      style={{ color, backgroundColor: tint(color, 0.16), fontSize: 11, fontWeight: "600", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: "hidden", ...style }}
    >
      {text}
    </Text>
  );
}

/** A labelled value: the label is a tag, so it reads apart from the value next to it. */
function Field({ tag, color, lines, valueStyle, children }: { tag: string; color: string; lines: number; valueStyle: TextStyle; children: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <Tag text={tag} color={color} style={{ fontSize: 10, fontWeight: "700", marginTop: 1, flexShrink: 0 }} />
      <Text selectable={false} numberOfLines={lines} style={{ flex: 1, ...valueStyle }}>
        {children}
      </Text>
    </View>
  );
}

const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

/** How full the agent's context window was after its last turn: a bar that warms from green to red, and the token counts. */
function ContextMeter({ used, max, colors }: { used?: number; max?: number; colors: Colors }) {
  const { t } = useTranslation(messages);
  if (!used || !max) return null;
  const share = Math.min(1, used / max);
  const color = share >= 0.8 ? RED : share >= 0.5 ? AMBER : GREEN;
  return (
    <View accessibilityLabel={t("card.contextUsed", { percent: Math.round(share * 100) })} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text selectable={false} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("card.context")}</Text>
      <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: tint(GRAY, 0.25), overflow: "hidden" }}>
        <View style={{ width: `${Math.max(2, share * 100)}%`, height: 4, backgroundColor: color }} />
      </View>
      <Text selectable={false} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{`${Math.round(share * 100)}%  ${tokens(used)} / ${tokens(max)}`}</Text>
    </View>
  );
}

/** A profile's icon and name in its color, as Paseo shows profiles. */
function ProfileChip({ profile }: { profile: Profile }) {
  const { t } = useTranslation(messages);
  const color = identityColor(profile.color);
  return (
    <View
      accessibilityLabel={t("card.profile", { name: profile.name })}
      style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: tint(color, 0.16) }}
    >
      {profile.icon ? <Icon name={profileIcon(profile.icon)} size={11} color={color} /> : null}
      <Text selectable={false} numberOfLines={1} style={{ flexShrink: 1, color, fontSize: 11, fontWeight: "700" }}>
        {profile.name}
      </Text>
    </View>
  );
}

/** The status is in the key, so a finished turn is summarized once more as it ends; the locale, so a new app language gets new summaries. */
const summaryKey = (agent: PaseoAgent, locale: string) => ["agent-board", "summary", agent.id, agent.status, locale];

/** The card's Haiku title once it has one, else the stored title. Reads the card's cached summary without fetching. */
function useShownTitle(agent: PaseoAgent, summaries: boolean, locale: string): string {
  const summary = useQuery<RpcOutput<typeof agentSummary>>({ queryKey: summaryKey(agent, locale), enabled: false });
  return (summaries ? summary.data?.title : null) ?? agent.title ?? agent.provider;
}

const AgentCard = memo(function AgentCard(props: {
  agent: PaseoAgent;
  x: number;
  y: number;
  dragging: boolean;
  summaries: boolean;
  icon?: string;
  /** The profile the agent was most likely started from. */
  profile: Profile | null;
  colors: Colors;
  handlers: RefObject<DragHandlers>;
  /** Another agent is highlighted and this one is not its ancestor or descendant. */
  dimmed: boolean;
  /** This agent is the highlighted one. */
  focused: boolean;
}) {
  const { agent, colors, handlers } = props;
  const { t, locale } = useTranslation(messages);
  const words = useMemo(
    () => ({
      read: t("tool.read"),
      edit: t("tool.edit"),
      write: t("tool.write"),
      search: t("tool.search"),
      fetch: t("tool.fetch"),
      subAgent: t("tool.subAgent"),
      failed: t("tool.failed"),
      thinking: t("tool.thinking"),
      error: t("tool.error"),
    }),
    [t],
  );
  const activity = describeActivity(useTimeline(agent.id), words);
  const running = agent.status === "running";
  const readSummary = useRpc(agentSummary);
  const summary = useQuery({
    queryKey: summaryKey(agent, locale),
    queryFn: () => readSummary({ agentId: agent.id, running, locale }),
    refetchInterval: running ? SUMMARY_POLL : false,
    retry: false,
    enabled: props.summaries,
    // The last summary stays until the next one arrives, so the title does not fall back to the raw prompt on a status change.
    placeholderData: keepPreviousData,
  });
  const summed = props.summaries ? summary.data : undefined;
  const title = summed?.title ?? agent.title ?? t("card.untitled");
  const doing = activity.compacting ? t("card.compactingNow") : (summed?.doing ?? activity.latest);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (e, g) => handlers.current.move(agent.id, g.dx, g.dy, shiftHeld(e)),
        onPanResponderRelease: (e, g) =>
          Math.abs(g.dx) + Math.abs(g.dy) < TAP_SLOP
            ? handlers.current.press(agent.id)
            : handlers.current.drop(agent.id, g.dx, g.dy, shiftHeld(e)),
        onPanResponderTerminate: () => handlers.current.cancel(),
      }),
    [agent.id, handlers],
  );
  const status = statusOf(agent, colors, activity.compacting);
  const statusLabel = t(`status.${status.key}`);
  const role = agent.labels.role;
  const mode = agent.availableModes.find((m) => m.id === agent.currentModeId)?.label ?? agent.currentModeId;
  const effort = agent.thinkingOptionId ?? agent.effectiveThinkingOptionId;
  const muted = { color: colors.foregroundMuted, fontSize: 12, lineHeight: LINE_H };
  return (
    <View
      {...pan.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${statusLabel}, ${agent.title ?? ""}`}
      accessibilityHint={t("card.hint")}
      onAccessibilityTap={() => handlers.current.press(agent.id)}
      onLayout={(event) => handlers.current.measure(agent.id, event.nativeEvent.layout.height)}
      style={{
        position: "absolute",
        left: props.x,
        top: props.y,
        width: CARD_W,
        padding: 12,
        gap: 8,
        overflow: "hidden",
        borderRadius: 12,
        borderWidth: running ? 2 : 1,
        borderColor: running ? AMBER : colors.border,
        backgroundColor: colors.surface1,
        borderStyle: ended(agent) ? "dashed" : "solid",
        opacity: props.dragging ? 0.85 : props.dimmed ? DIM : ended(agent) ? 0.6 : 1,
        zIndex: props.dragging ? 10 : 1,
        cursor: "pointer",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 22 }}>
        <ProviderLogo provider={agent.provider} svg={props.icon} colors={colors} />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, overflow: "hidden" }}>
          <Text
            selectable={false}
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" }}
          >
            {role ? `${role} / ${agent.provider}` : agent.provider}
          </Text>
          {props.profile ? <ProfileChip profile={props.profile} /> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.focused ? t("card.unfocus") : t("card.focus")}
          onPress={() => handlers.current.focus(agent.id)}
          style={{ padding: 2, cursor: "pointer" }}
        >
          <Icon name="Crosshair" size={14} color={props.focused ? AMBER : colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("card.hide")}
          onPress={() => handlers.current.hide(agent.id)}
          style={{ padding: 2, cursor: "pointer" }}
        >
          <Icon name="EyeOff" size={14} color={colors.foregroundMuted} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status.color }} />
          <Text selectable={false} style={{ color: status.color, fontSize: 11, fontWeight: "700" }}>
            {statusLabel}
          </Text>
        </View>
      </View>
      <Text selectable={false} numberOfLines={2} style={{ color: colors.foreground, fontSize: 15, lineHeight: 20, fontWeight: "700" }}>
        {title}
      </Text>
      <View style={{ flexDirection: "row", gap: 4, height: 20, overflow: "hidden" }}>
        {agent.model ? <Tag text={shortModel(agent.model)} color={PROVIDER_COLORS[agent.provider] ?? BLUE} label={t("card.model", { value: agent.model })} /> : null}
        {effort ? <Tag text={effort} color={effortColor(effort)} label={t("card.effort", { value: effort })} /> : null}
        {mode ? <Tag text={mode} color={modeColor(`${agent.currentModeId ?? ""} ${mode}`)} label={t("card.mode", { value: mode })} /> : null}
      </View>
      <ContextMeter used={agent.lastUsage?.contextWindowUsedTokens} max={agent.lastUsage?.contextWindowMaxTokens} colors={colors} />
      <View style={{ height: 1, backgroundColor: colors.border }} />
      {/* Two lines of fixed height, so a new summary does not resize the card and shift the rows below. */}
      <Field tag={activity.compacting ? t("field.compact") : running ? t("field.now") : t("field.last")} color={activity.compacting ? PURPLE : running ? AMBER : GRAY} lines={2} valueStyle={{ ...muted, color: colors.foreground, fontSize: 13, height: 2 * LINE_H }}>
        {doing ?? (props.summaries && summary.isLoading ? t("card.summarizing") : t("card.noActivity"))}
      </Field>
      {running && summed?.doing && activity.latest ? (
        <Field tag={t("field.tool")} color={BLUE} lines={1} valueStyle={muted}>
          {activity.latest}
        </Field>
      ) : null}
      {activity.step ? (
        <Field tag={t("field.step")} color={GREEN} lines={1} valueStyle={muted}>
          {activity.step}
        </Field>
      ) : null}
    </View>
  );
});

/** An axis-aligned 2px line inside a thicker pressable strip. */
function Segment({ x1, y1, x2, y2, color, onPress }: { x1: number; y1: number; x2: number; y2: number; color: string; onPress(): void }) {
  const horizontal = y1 === y2;
  const length = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1) + 2;
  return (
    <Pressable
      accessible={false}
      onPress={onPress}
      style={{
        position: "absolute",
        left: horizontal ? Math.min(x1, x2) : x1 - HIT / 2,
        top: horizontal ? y1 - HIT / 2 : Math.min(y1, y2) - 1,
        width: horizontal ? length : HIT,
        height: horizontal ? HIT : length,
        justifyContent: "center",
        alignItems: "center",
        cursor: "pointer",
      }}
    >
      <View style={horizontal ? { alignSelf: "stretch", height: 2, backgroundColor: color } : { alignSelf: "stretch", width: 2, marginHorizontal: (HIT - 2) / 2, flex: 1, backgroundColor: color }} />
    </Pressable>
  );
}

type ArrowPath = ReturnType<typeof arrowPath>;

/** Above cards (zIndex 1) and a dragged card (10): the instruction buttons, then the open message box. */
const BUTTON_Z = 20;
const BUBBLE_Z = 30;

/** A triangle whose tip touches `tip`, pointing in `direction`. */
function arrowHead(tip: Point, direction: ArrowDirection, color: string) {
  const half = ARROW / 2 + 1;
  const clear = "transparent";
  switch (direction) {
    case "right":
      return { left: tip.x - ARROW, top: tip.y - half, borderTopWidth: half, borderBottomWidth: half, borderTopColor: clear, borderBottomColor: clear, borderLeftWidth: ARROW, borderLeftColor: color };
    case "left":
      return { left: tip.x, top: tip.y - half, borderTopWidth: half, borderBottomWidth: half, borderTopColor: clear, borderBottomColor: clear, borderRightWidth: ARROW, borderRightColor: color };
    case "down":
      return { left: tip.x - half, top: tip.y - ARROW, borderLeftWidth: half, borderRightWidth: half, borderLeftColor: clear, borderRightColor: clear, borderTopWidth: ARROW, borderTopColor: color };
    case "up":
      return { left: tip.x - half, top: tip.y, borderLeftWidth: half, borderRightWidth: half, borderLeftColor: clear, borderRightColor: clear, borderBottomWidth: ARROW, borderBottomColor: color };
  }
}

/** An elbow arrow from a parent card to the child it started. While the child runs, dots travel along it toward the child. */
function ArrowLines(props: { path: ArrowPath; active: boolean; colors: Colors; flow: Animated.Value; onPress(): void }) {
  const { path, active, flow, onPress } = props;
  const [p0, p1, p2, p3] = path.points;
  const color = active ? AMBER : props.colors.foregroundMuted;
  const lengths = [Math.hypot(p1.x - p0.x, p1.y - p0.y), Math.hypot(p2.x - p1.x, p2.y - p1.y), Math.hypot(p3.x - p2.x, p3.y - p2.y)];
  const total = Math.max(1, lengths[0] + lengths[1] + lengths[2]);
  const inputRange = [0, lengths[0] / total, (lengths[0] + lengths[1]) / total, 1];
  return (
    <>
      <Segment x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} color={color} onPress={onPress} />
      <Segment x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} color={color} onPress={onPress} />
      <Segment x1={p2.x} y1={p2.y} x2={p3.x} y2={p3.y} color={color} onPress={onPress} />
      <View pointerEvents="none" style={{ position: "absolute", width: 0, height: 0, ...arrowHead(path.tip, path.direction, color) }} />
      {active
        ? FLOW_DOTS.map((offset) => {
            const t = Animated.modulo(Animated.add(flow, offset), 1);
            return (
              <Animated.View
                key={offset}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: -3,
                  top: -3,
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: AMBER,
                  transform: [
                    { translateX: t.interpolate({ inputRange, outputRange: [p0.x, p1.x, p2.x, p3.x] }) },
                    { translateY: t.interpolate({ inputRange, outputRange: [p0.y, p1.y, p2.y, p3.y] }) },
                  ],
                }}
              />
            );
          })
        : null}
    </>
  );
}

/** The instruction button in the middle of an arrow, above the cards so nothing covers it. */
function ArrowButton(props: { path: ArrowPath; active: boolean; open: boolean; colors: Colors; onPress(): void }) {
  const { t } = useTranslation(messages);
  const { x, y } = props.path.button;
  const color = props.active || props.open ? AMBER : props.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.open ? t("instructions.close") : t("instructions.open")}
      onPress={props.onPress}
      style={{
        position: "absolute",
        left: x - 11,
        top: y - 11,
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: color,
        backgroundColor: props.open ? tint(AMBER, 0.2) : props.colors.surface1,
        cursor: "pointer",
      }}
    >
      <Icon name="MessageSquareText" size={12} color={color} />
    </Pressable>
  );
}

const BUBBLE_W = 400;
const BUBBLE_H = 440;
/** The bubble's smallest height, and its distance from the button and from the edges of its space. */
const BUBBLE_MIN_H = 140;
const BUBBLE_GAP = 15;
const BUBBLE_MARGIN = 8;
/** The bubble's scroller; the board's wheel handler leaves wheel input over it alone. */
const BUBBLE_SCROLL_ID = "agent-board-bubble";

/** One instruction: Haiku's goal and main points when summaries are on, and the original as sent, folded while a summary shows. */
function Instruction(props: { index: number; text: string; at: string; summaries: boolean; colors: Colors }) {
  const { index, text, colors } = props;
  const { t, locale } = useTranslation(messages);
  const readSummary = useRpc(instructionSummary);
  const summary = useQuery({
    queryKey: ["agent-board", "instruction", locale, text],
    queryFn: () => readSummary({ text, locale }),
    enabled: props.summaries,
    retry: false,
    staleTime: Infinity,
  });
  const [showOriginal, setShowOriginal] = useState(false);
  const summed = props.summaries && summary.data?.goal ? summary.data : null;
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const body = { color: colors.foreground, fontSize: 13, lineHeight: 19 };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Tag text={index === 0 ? t("instructions.first") : t("instructions.followUp", { index })} color={index === 0 ? AMBER : BLUE} style={{ fontSize: 10, fontWeight: "700" }} />
        <Text style={muted}>{new Date(props.at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Text>
      </View>
      {summed ? (
        <View style={{ gap: 3 }}>
          <Text selectable style={{ ...body, fontWeight: "700" }}>{summed.goal}</Text>
          {summed.points.map((point, i) => (
            <Text key={i} selectable style={body}>{`•  ${point}`}</Text>
          ))}
        </View>
      ) : props.summaries && summary.isLoading ? (
        <Text style={muted}>{t("card.summarizing")}</Text>
      ) : null}
      {summed ? (
        <Pressable accessibilityRole="button" onPress={() => setShowOriginal((value) => !value)} style={{ alignSelf: "flex-start", cursor: "pointer" }}>
          <Text style={{ ...muted, textDecorationLine: "underline" }}>{showOriginal ? t("instructions.hideOriginal") : t("instructions.showOriginal")}</Text>
        </Pressable>
      ) : null}
      {!summed || showOriginal ? (
        <Text selectable style={summed ? { ...body, color: colors.foregroundMuted } : body}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A message box over an arrow's button with the instructions the parent sent the child, oldest first:
 * the first is the delegation, later ones follow-ups.
 */
function InstructionBubble(props: {
  /** The button's center, in the coordinates of the view the bubble is drawn in. */
  anchor: Point;
  /** The visible area of that view; the bubble takes the side of the button with more room and fits inside. */
  space: { width: number; height: number };
  from: PaseoAgent;
  to: PaseoAgent;
  summaries: boolean;
  colors: Colors;
  onClose(): void;
}) {
  const { anchor, space, from, to, colors } = props;
  const { t, locale } = useTranslation(messages);
  const fromTitle = useShownTitle(from, props.summaries, locale);
  const toTitle = useShownTitle(to, props.summaries, locale);
  const paseo = usePaseo();
  const prompts = useQuery({
    queryKey: ["agent-board", "instructions", from.id, to.id],
    queryFn: async () => {
      // The whole timeline, as `paseo logs` reads it: a bounded tail counts streamed answer chunks as rows and soon loses the first prompt.
      const page = await paseo.agents.ref(to.id).timeline.refetch({ direction: "tail", limit: 0 });
      return page.entries.flatMap((entry) => {
        const given = promptOf(entry.item);
        return given?.from === from.id ? [{ text: given.text, at: entry.timestamp }] : [];
      });
    },
  });
  const roomAbove = anchor.y - BUBBLE_GAP - BUBBLE_MARGIN;
  const roomBelow = space.height - anchor.y - BUBBLE_GAP - BUBBLE_MARGIN;
  const above = roomAbove >= BUBBLE_H || roomAbove >= roomBelow;
  const maxHeight = Math.max(BUBBLE_MIN_H, Math.min(BUBBLE_H, above ? roomAbove : roomBelow));
  const left = Math.max(BUBBLE_MARGIN, Math.min(anchor.x - BUBBLE_W / 2, space.width - BUBBLE_W - BUBBLE_MARGIN));
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  return (
    <>
      {/* Clear cover under the box over the rest of the board: pressing anywhere outside the box closes it. */}
      <Pressable
        accessibilityLabel={t("instructions.close")}
        onPress={props.onClose}
        style={{ position: "absolute", left: 0, top: 0, width: space.width, height: space.height, zIndex: BUBBLE_Z }}
      />
      {/* The tail, pointing at the button. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: anchor.x - 7,
          top: above ? anchor.y - 15 : anchor.y + 8,
          width: 0,
          height: 0,
          borderLeftWidth: 7,
          borderRightWidth: 7,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          ...(above ? { borderTopWidth: 7, borderTopColor: colors.border } : { borderBottomWidth: 7, borderBottomColor: colors.border }),
          zIndex: BUBBLE_Z,
        }}
      />
      <View
        style={{
          position: "absolute",
          left,
          width: BUBBLE_W,
          maxHeight,
          ...(above ? { bottom: space.height - (anchor.y - BUBBLE_GAP) } : { top: anchor.y + BUBBLE_GAP }),
          zIndex: BUBBLE_Z,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface1,
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          overflow: "hidden",
        }}
      >
        <View style={{ gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "700" }}>{t("instructions.title")}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t("instructions.close")} onPress={props.onClose} style={{ padding: 2, cursor: "pointer" }}>
              <Icon name="X" size={14} color={colors.foregroundMuted} />
            </Pressable>
          </View>
          <Text style={{ ...muted, lineHeight: 17 }}>{`${fromTitle}  →  ${toTitle}`}</Text>
        </View>
        <ScrollView nativeID={BUBBLE_SCROLL_ID} contentContainerStyle={{ padding: 12, gap: 10 }}>
          {prompts.isLoading ? (
            <Text style={muted}>{t("instructions.loading")}</Text>
          ) : prompts.isError ? (
            <Text style={{ color: colors.statusDanger, fontSize: 13 }}>{t("instructions.failed")}</Text>
          ) : !prompts.data?.length ? (
            <Text style={muted}>{t("instructions.none")}</Text>
          ) : (
            prompts.data.map((prompt, index) => (
              <Instruction key={index} index={index} text={prompt.text} at={prompt.at} summaries={props.summaries} colors={colors} />
            ))
          )}
        </ScrollView>
      </View>
    </>
  );
}

interface GroupHandlers {
  moveGroup(workspaceId: string, dx: number, dy: number): void;
  dropGroup(workspaceId: string, dx: number, dy: number): void;
  cancelGroup(): void;
}

/** A workspace's dashed box; dragging it moves every card of the workspace. Cards and arrows above it keep their own input. */
function WorkspaceBox(props: {
  box: Box;
  name: string;
  /** The workspace's labels with their Paseo color names, in the order Paseo lists them. */
  labels: Array<{ name: string; color: string | undefined }>;
  color: string;
  handlers: RefObject<GroupHandlers>;
}) {
  const { box, name, color, handlers } = props;
  const { t } = useTranslation(messages);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => handlers.current.moveGroup(box.workspaceId, g.dx, g.dy),
        onPanResponderRelease: (_, g) =>
          Math.abs(g.dx) + Math.abs(g.dy) < TAP_SLOP ? handlers.current.cancelGroup() : handlers.current.dropGroup(box.workspaceId, g.dx, g.dy),
        onPanResponderTerminate: () => handlers.current.cancelGroup(),
      }),
    [box.workspaceId, handlers],
  );
  return (
    <View
      {...pan.panHandlers}
      accessibilityLabel={t("workspace.box", { name })}
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        borderRadius: 14,
        borderWidth: 1.5,
        borderStyle: "dashed",
        borderColor: tint(color, 0.6),
        backgroundColor: tint(color, 0.06),
        cursor: "pointer",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: BOX_LABEL, paddingHorizontal: 12, overflow: "hidden" }}>
        <Text selectable={false} numberOfLines={1} style={{ flexShrink: 1, color, fontSize: 12, fontWeight: "700" }}>
          {name}
        </Text>
        {props.labels.map((label) => (
          <Tag key={label.name} text={label.name} color={identityColor(label.color)} label={t("workspace.label", { name: label.name })} style={{ fontSize: 10, fontWeight: "700", flexShrink: 0 }} />
        ))}
      </View>
    </View>
  );
}

function Toggle({ on, label, onPress, colors }: { on: boolean; label: string; onPress(): void; colors: Colors }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: on ? GREEN : colors.border,
        backgroundColor: on ? tint(GREEN, 0.12) : "transparent",
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: on ? GREEN : GRAY }} />
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function HeaderButton({ label, onPress, colors }: { label: string; onPress(): void; colors: Colors }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}
    >
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

export function AgentBoard({ theme, layout, workspaceId, navigation, tab }: PluginWorkspacePanelProps) {
  const colors = theme.colors;
  /** Cards, arrow buttons and the instruction box; they stay dark on light themes, the rest of the board follows the theme. */
  const node = nodeColors(colors);
  const { t } = useTranslation(messages);
  const [view, setView] = useTabState(tab, viewSchema, DEFAULT_VIEW);
  const { agents, workspaces } = useLiveLists(view.showClosed);
  const profiles = useProfiles();
  const labelColors = useLabelColors([...workspaces.values()].flatMap((w) => w.labels));
  const settings = useSettings(boardLayout);
  const { visible, hiddenCount } = useMemo(() => {
    const projectId = workspaces.get(workspaceId)?.projectId ?? null;
    const inScope = (id: string | undefined) =>
      id === workspaceId || (projectId !== null && id !== undefined && workspaces.get(id)?.projectId === projectId);
    const now = Date.now();
    const recent = (a: PaseoAgent) => now - Date.parse(a.archivedAt ?? a.updatedAt) < ENDED_WINDOW;
    const inProject = [...agents.values()].filter((a) => inScope(a.workspaceId) && (!ended(a) || (view.showClosed && recent(a))));
    const hidden = subtrees(inProject, view.hidden.filter((id) => inProject.some((a) => a.id === id)));
    return { visible: inProject.filter((a) => !hidden.has(a.id)), hiddenCount: hidden.size };
  }, [agents, workspaces, workspaceId, view.showClosed, view.hidden]);
  const focus = view.focus !== null && visible.some((a) => a.id === view.focus) ? view.focus : null;
  const highlighted = useMemo(() => (focus === null ? null : lineage(visible, focus)), [visible, focus]);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const tree = useMemo(() => treeLayout(visible, heights, view.group), [visible, heights, view.group]);

  // Saved positions live locally while a save is pending, so a dropped card does not jump back.
  const [saved, setSaved] = useState<Record<string, Point>>({});
  const [summaries, setSummaries] = useState(true);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const revision = settings.status === "ready" ? settings.revision : null;
  useEffect(() => {
    if (settings.status !== "ready" || dirtyRef.current) return;
    setSaved(settings.values.positions);
    setSummaries(settings.values.summaries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  useEffect(() => {
    if (!dirty || settings.status !== "ready" || settings.saving) return;
    dirtyRef.current = false;
    setDirty(false);
    // Positions of archived agents are dropped; agents of other projects keep theirs.
    const positions = Object.fromEntries(Object.entries(saved).filter(([id]) => agents.has(id)));
    // shortcut: a save that conflicts with another tab reloads and keeps this move only on screen until the next drop.
    void settings.save({ positions, summaries }, settings.revision).then((ok) => {
      if (!ok) void settings.reload();
    });
  }, [dirty, settings, saved, summaries, agents]);
  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };

  const paseo = usePaseo();
  const providers = useQuery({ queryKey: ["agent-board", "providers"], queryFn: () => paseo.providers.snapshot() });
  const icons = useMemo(
    () => new Map((providers.data?.entries ?? []).map((entry) => [entry.provider, entry.iconSvg ?? undefined])),
    [providers.data],
  );

  /** On the web the board is a camera over the canvas: an offset in screen pixels and a scale. Native scrolls instead. */
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const zoom = camera.zoom;
  const viewport = useRef<View>(null);
  const [port, setPort] = useState({ width: 0, height: 0 });
  /** Canvas and viewport size, read by state updaters that run between renders. */
  const bounds = useRef({ width: 0, height: 0, portWidth: 0, portHeight: 0 });
  const clampCamera = (c: typeof camera) => {
    const b = bounds.current;
    return {
      zoom: c.zoom,
      x: Math.max(0, Math.min(c.x, b.width * c.zoom - b.portWidth)),
      y: Math.max(0, Math.min(c.y, b.height * c.zoom - b.portHeight)),
    };
  };
  useEffect(() => {
    const offWheel = listenForWheel(viewport.current, {
      // Zoom about the pointer: the canvas point under it stays under it.
      zoom: (factor, px, py) =>
        setCamera((c) => {
          const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
          return clampCamera({ zoom: next, x: ((c.x + px) / c.zoom) * next - px, y: ((c.y + py) / c.zoom) * next - py });
        }),
      pan: (dx, dy) => setCamera((c) => clampCamera({ ...c, x: c.x + dx, y: c.y + dy })),
    }, `#${BUBBLE_SCROLL_ID}`);
    const offUndo = listenForUndo(viewport.current, () => handlers.current.undo());
    return () => {
      offWheel();
      offUndo();
    };
    // The viewport mounts with the first agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length > 0]);
  /** Earlier layouts for ⌘Z, newest last. */
  const history = useRef<Record<string, Point>[]>([]);
  const remember = () => {
    history.current = [...history.current.slice(1 - UNDO_DEPTH), saved];
  };
  const flow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(flow, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" }),
    );
    loop.start();
    return () => loop.stop();
  }, [flow]);
  const [opened, setOpened] = useState<{ from: string; to: string } | null>(null);

  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; shift: boolean } | null>(null);
  const basePosition = (id: string): Point => saved[id] ?? tree.positions[id] ?? { x: PAD, y: PAD };
  const dragPosition = (id: string, dx: number, dy: number, shift: boolean): Point => {
    const base = basePosition(id);
    const raw = { x: Math.max(0, base.x + dx), y: Math.max(0, base.y + dy) };
    if (!shift) return raw;
    const others = visible
      .filter((a) => a.id !== id)
      .map((a) => ({ ...basePosition(a.id), height: heights[a.id] ?? DEFAULT_H }));
    return snapPoint(raw, heights[id] ?? DEFAULT_H, others);
  };
  const [groupDrag, setGroupDrag] = useState<{ workspaceId: string; dx: number; dy: number } | null>(null);
  const members = (workspaceId: string) => visible.filter((a) => (a.workspaceId ?? "") === workspaceId);
  /** A workspace move, held back from going further past the left or top edge than the box needs. */
  const groupDelta = (workspaceId: string, dx: number, dy: number) => {
    const cards = members(workspaceId).map((a) => basePosition(a.id));
    const minX = Math.min(...cards.map((p) => p.x));
    const minY = Math.min(...cards.map((p) => p.y));
    return { dx: Math.max(dx, Math.min(0, BOX_PAD - minX)), dy: Math.max(dy, Math.min(0, BOX_PAD + BOX_LABEL - minY)) };
  };
  const positionOf = (id: string): Point => {
    if (drag?.id === id) return dragPosition(id, drag.dx, drag.dy, drag.shift);
    const base = basePosition(id);
    return groupDrag && (agents.get(id)?.workspaceId ?? "") === groupDrag.workspaceId
      ? { x: base.x + groupDrag.dx, y: base.y + groupDrag.dy }
      : base;
  };
  const handlers = useRef<DragHandlers & GroupHandlers & { undo(): void }>(null!);
  handlers.current = {
    // Gestures report screen pixels; the board is scaled by zoom.
    move: (id, dx, dy, shift) => setDrag({ id, dx: dx / zoom, dy: dy / zoom, shift }),
    drop: (id, dx, dy, shift) => {
      const point = dragPosition(id, dx / zoom, dy / zoom, shift);
      remember();
      setSaved((current) => ({ ...current, [id]: point }));
      setDrag(null);
      markDirty();
    },
    cancel: () => setDrag(null),
    moveGroup: (workspaceId, dx, dy) => setGroupDrag({ workspaceId, ...groupDelta(workspaceId, dx / zoom, dy / zoom) }),
    dropGroup: (workspaceId, dx, dy) => {
      const delta = groupDelta(workspaceId, dx / zoom, dy / zoom);
      const moved = Object.fromEntries(
        members(workspaceId).map((a) => {
          const base = basePosition(a.id);
          return [a.id, { x: base.x + delta.dx, y: base.y + delta.dy }];
        }),
      );
      remember();
      setSaved((current) => ({ ...current, ...moved }));
      setGroupDrag(null);
      markDirty();
    },
    cancelGroup: () => setGroupDrag(null),
    focus: (id) => setView({ ...view, focus: focus === id ? null : id }),
    hide: (id) => setView({ ...view, hidden: [...view.hidden, id] }),
    undo: () => {
      const previous = history.current.pop();
      if (!previous) return;
      setSaved(previous);
      markDirty();
    },
    measure: (id, h) =>
      setHeights((current) => (Math.abs((current[id] ?? 0) - h) < 1 ? current : { ...current, [id]: h })),
    press: (id) => {
      setDrag(null);
      navigation?.openAgent({ agentId: id });
    },
  };
  const toggleSummaries = () => {
    setSummaries((value) => !value);
    markDirty();
  };
  const resetLayout = () => {
    remember();
    const ids = new Set(visible.map((a) => a.id));
    setSaved((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))));
    markDirty();
  };

  const placed = visible.map((agent) => ({ agent, ...positionOf(agent.id) }));
  const width = Math.max(0, ...placed.map((p) => p.x + CARD_W + PAD));
  const height = Math.max(0, ...placed.map((p) => p.y + (heights[p.agent.id] ?? DEFAULT_H) + PAD));
  const working = visible.filter((a) => a.status === "running").length;
  const waiting = visible.filter((a) => a.pendingPermissions.length > 0 || a.status === "error").length;
  const hasCustom = visible.some((a) => saved[a.id]);
  bounds.current = { width, height, portWidth: port.width, portHeight: port.height };
  const cam = clampCamera(camera);
  const boxes = view.group
    ? groupBoxes(placed.map((p) => ({ x: p.x, y: p.y, workspaceId: p.agent.workspaceId ?? "", height: heights[p.agent.id] ?? DEFAULT_H })))
    : [];
  const dimEdge = (edge: { from: string; to: string }) => highlighted !== null && !(highlighted.has(edge.from) && highlighted.has(edge.to));
  const pathOf = (edge: { from: string; to: string }) =>
    arrowPath(positionOf(edge.from), heights[edge.from] ?? DEFAULT_H, positionOf(edge.to), heights[edge.to] ?? DEFAULT_H, ARROW);
  const openFrom = opened ? agents.get(opened.from) : undefined;
  const openTo = opened ? agents.get(opened.to) : undefined;
  const toggleOpened = (edge: { from: string; to: string }) =>
    setOpened(opened?.from === edge.from && opened.to === edge.to ? null : edge);
  /** On the web the bubble is drawn over the viewport, unscaled, so zoom and the board's edges do not cut it; native draws it in the canvas. */
  const bubble = (space: { width: number; height: number }, place: (point: Point) => Point) =>
    opened && openFrom && openTo ? (
      <InstructionBubble
        anchor={place(pathOf(opened).button)}
        space={space}
        from={openFrom}
        to={openTo}
        summaries={summaries}
        colors={node}
        onClose={() => setOpened(null)}
      />
    ) : null;
  // Back to front: workspace boxes, arrow lines, cards, arrow buttons, the open message box.
  const canvas = (
    <>
      {boxes.map((box) => (
        <WorkspaceBox
          key={box.workspaceId}
          box={box}
          name={workspaces.get(box.workspaceId)?.name ?? t("workspace.none")}
          labels={(workspaces.get(box.workspaceId)?.labels ?? []).map((label) => ({ name: label, color: labelColors.get(label) }))}
          color={BOX_COLORS[colorIndex(box.workspaceId, BOX_COLORS.length)]}
          handlers={handlers}
        />
      ))}
      {tree.edges.map((edge) => (
        <View
          key={`${edge.from}>${edge.to}`}
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, top: 0, opacity: dimEdge(edge) ? DIM : 1 }}
        >
          <ArrowLines
            path={pathOf(edge)}
            active={agents.get(edge.to)?.status === "running"}
            colors={colors}
            flow={flow}
            onPress={() => toggleOpened(edge)}
          />
        </View>
      ))}
      {placed.map(({ agent, x, y }) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          x={x}
          y={y}
          dragging={drag?.id === agent.id}
          summaries={summaries}
          icon={icons.get(agent.provider)}
          profile={profileOf({ provider: agent.provider, model: agent.model, modeId: agent.currentModeId, thinkingOptionId: agent.thinkingOptionId ?? null }, profiles)}
          colors={node}
          handlers={handlers}
          dimmed={highlighted !== null && !highlighted.has(agent.id)}
          focused={agent.id === focus}
        />
      ))}
      {tree.edges.map((edge) => (
        <View
          key={`${edge.from}>${edge.to}`}
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, top: 0, opacity: dimEdge(edge) ? DIM : 1, zIndex: BUTTON_Z }}
        >
          <ArrowButton
            path={pathOf(edge)}
            active={agents.get(edge.to)?.status === "running"}
            open={opened?.from === edge.from && opened.to === edge.to}
            colors={node}
            onPress={() => toggleOpened(edge)}
          />
        </View>
      ))}
      {Platform.OS !== "web" ? bubble({ width, height }, (point) => point) : null}
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: layout.compact ? 16 : 24,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>{t("panel.title")}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {t("header.counts", { total: visible.length, working, attention: waiting })}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {t("header.hints", { zoom: Math.round(zoom * 100) })}
        </Text>
        {/* Shrinkable and wrapping so narrow panels (phones) keep every toggle on screen instead of past the right edge. */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 1, alignItems: "center", gap: 8, marginLeft: "auto" }}>
          <Toggle on={view.group} label={t("header.group")} onPress={() => setView({ ...view, group: !view.group })} colors={colors} />
          <Toggle
            on={view.showClosed}
            label={t("header.ended")}
            onPress={() => setView({ ...view, showClosed: !view.showClosed })}
            colors={colors}
          />
          <Toggle on={summaries} label={summaries ? t("header.summariesOn") : t("header.summariesOff")} onPress={toggleSummaries} colors={colors} />
          {focus ? <HeaderButton label={t("header.clearFocus")} onPress={() => setView({ ...view, focus: null })} colors={colors} /> : null}
          {view.hidden.length > 0 ? (
            <HeaderButton label={t("header.showHidden", { count: hiddenCount })} onPress={() => setView({ ...view, hidden: [] })} colors={colors} />
          ) : null}
          {hasCustom ? <HeaderButton label={t("header.reset")} onPress={resetLayout} colors={colors} /> : null}
        </View>
      </View>
      {visible.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, padding: 24 }}>
          {view.hidden.length > 0 ? t("empty.hidden") : t("empty.none")}
        </Text>
      ) : (
        <View
          ref={viewport}
          onLayout={(event) => setPort({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
          style={{ flex: 1, overflow: "hidden" }}
        >
          {Platform.OS === "web" ? (
            <View
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width,
                height,
                transformOrigin: "0 0",
                transform: [{ translateX: -cam.x }, { translateY: -cam.y }, { scale: zoom }],
              }}
            >
              {canvas}
            </View>
          ) : null}
          {Platform.OS === "web" ? (
            bubble(port, (point) => ({ x: point.x * zoom - cam.x, y: point.y * zoom - cam.y }))
          ) : (
            <ScrollView style={{ flex: 1 }}>
              <ScrollView horizontal>
                <View style={{ width, height }}>
                  {canvas}
                </View>
              </ScrollView>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}
