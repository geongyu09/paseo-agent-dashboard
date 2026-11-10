import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  clientX: number;
  clientY: number;
  target: unknown;
  preventDefault(): void;
}
interface WheelTarget {
  addEventListener(type: "wheel", listener: (event: WheelLike) => void, options: { passive: boolean }): void;
  removeEventListener(type: "wheel", listener: (event: WheelLike) => void): void;
  getBoundingClientRect(): { left: number; top: number };
}

/**
 * Wheel and trackpad input over `node`, a View's ref (a DOM element on the web). Ctrl or ⌘ + wheel and trackpad pinch,
 * which browsers report as Ctrl + wheel, call zoom with a scale factor and the pointer's position in the node;
 * other scrolling calls pan with pixel deltas, Shift + wheel panning sideways. Off the web this is a no-op.
 */
export function listenForWheel(
  node: unknown,
  on: { zoom(factor: number, x: number, y: number): void; pan(dx: number, dy: number): void },
  /** CSS selector of scrollers inside the board that keep plain wheel input. */
  skip?: string,
): () => void {
  if (Platform.OS !== "web" || typeof (node as WheelTarget | null)?.addEventListener !== "function") return () => {};
  const target = node as WheelTarget;
  const listener = (event: WheelLike) => {
    // A scroller inside the board, such as the instruction box, keeps its own wheel input.
    if (!event.ctrlKey && !event.metaKey && skip && (event.target as { closest?(selector: string): unknown } | null)?.closest?.(skip)) return;
    event.preventDefault(); // the board moves instead of the page, and Ctrl + wheel does not zoom the whole window
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    if (event.ctrlKey || event.metaKey) {
      const rect = target.getBoundingClientRect();
      // A mouse wheel notch (deltaY ~100) is capped so one notch zooms about 22%; pinch deltas are small and smooth.
      on.zoom(Math.exp(-Math.max(-50, Math.min(50, event.deltaY * unit)) * 0.005), event.clientX - rect.left, event.clientY - rect.top);
      return;
    }
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.shiftKey && dx === 0) on.pan(dy, 0);
    else on.pan(dx, dy);
  };
  target.addEventListener("wheel", listener, { passive: false });
  return () => target.removeEventListener("wheel", listener);
}

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  target: unknown;
  preventDefault(): void;
}
interface HoverTarget {
  addEventListener(type: "mouseenter" | "mouseleave", listener: () => void): void;
  removeEventListener(type: "mouseenter" | "mouseleave", listener: () => void): void;
}
declare const window: {
  addEventListener(type: "keydown", listener: (event: KeyLike) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyLike) => void): void;
};

/**
 * Calls onUndo for ⌘Z or Ctrl+Z while the pointer is over `node` and focus is not in a text field,
 * so the composer and other panels keep their own undo. Off the web this is a no-op.
 */
export function listenForUndo(node: unknown, onUndo: () => void): () => void {
  if (Platform.OS !== "web" || typeof (node as HoverTarget | null)?.addEventListener !== "function") return () => {};
  const target = node as HoverTarget;
  let hovering = false;
  const enter = () => (hovering = true);
  const leave = () => (hovering = false);
  const keydown = (event: KeyLike) => {
    if (!hovering || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
    const focused = event.target as { tagName?: string; isContentEditable?: boolean } | null;
    if (focused?.isContentEditable || focused?.tagName === "INPUT" || focused?.tagName === "TEXTAREA") return;
    event.preventDefault();
    onUndo();
  };
  target.addEventListener("mouseenter", enter);
  target.addEventListener("mouseleave", leave);
  window.addEventListener("keydown", keydown);
  return () => {
    target.removeEventListener("mouseenter", enter);
    target.removeEventListener("mouseleave", leave);
    window.removeEventListener("keydown", keydown);
  };
}
