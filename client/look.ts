import type { PluginTheme } from "@getpaseo/plugin";

/** Fixed mid-tone colors that read on light and dark themes; tags use them as text over a tint of themselves. */
export const BLUE = "#58a6ff";
export const GREEN = "#3fb950";
export const AMBER = "#ffb347";
export const ORANGE = "#f0883e";
export const RED = "#f85149";
export const GRAY = "#8b949e";
export const PURPLE = "#a371f7";

export const PROVIDER_COLORS: Record<string, string> = { claude: "#D97757", codex: "#10A37F" };

const EFFORT_COLORS: Record<string, string> = { minimal: GRAY, low: GREEN, medium: BLUE, high: AMBER, xhigh: ORANGE, max: RED };

export function effortColor(effort: string): string {
  return EFFORT_COLORS[effort.toLowerCase()] ?? GRAY;
}

/** Riskier permission modes are warmer: bypass and full access red, auto amber, plan blue, asking green. */
export function modeColor(mode: string): string {
  const text = mode.toLowerCase();
  if (/bypass|full|danger|yolo/.test(text)) return RED;
  if (/auto|accept/.test(text)) return AMBER;
  if (/plan/.test(text)) return BLUE;
  return GREEN;
}

/** #rrggbb as rgba with the given alpha; other color strings are returned unchanged. */
export function tint(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Paseo's identity colors, which workspace labels and agent profiles name; the same mid-tones the app draws them in. */
const IDENTITY_COLORS: Record<string, string> = {
  violet: "#7a6aa8",
  sky: "#3d7ea6",
  emerald: "#388068",
  orange: "#a4673a",
  pink: "#b05c80",
  indigo: "#6a70b8",
  teal: "#368080",
  red: "#b06260",
  amber: "#8f7838",
  blue: "#5179b0",
};

export function identityColor(name: string | null | undefined): string {
  return (name && IDENTITY_COLORS[name]) || GRAY;
}

/** What Paseo hands plugins under its dark Ghostty theme; on light themes cards keep these colors. */
export const GHOSTTY: PluginTheme["colors"] = {
  surface0: "#282c34",
  surface1: "#2f333d",
  surface2: "#383c48",
  border: "#353a47",
  foreground: "#fafafa",
  foregroundMuted: "#c8ccd8",
  accent: "#3570e0",
  accentForeground: "#ffffff",
  statusSuccess: "#6cb17b",
  statusWarning: "#c09664",
  statusDanger: "#d8847b",
};

/** Card colors: Ghostty's when surface0 is light (Rec.601 luma > 128), else the theme's; non-hex counts as dark. */
export function nodeColors(colors: PluginTheme["colors"]): PluginTheme["colors"] {
  const match = /^#([0-9a-f]{6})$/i.exec(colors.surface0);
  if (!match) return colors;
  const n = parseInt(match[1], 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 128 ? GHOSTTY : colors;
}
