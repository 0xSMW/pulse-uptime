// Shared primitives for whole-row click navigation in tables and lists.
// The whole row is the click target, but nested interactive controls (links,
// buttons, inputs, menus) keep their own clicks. See AGENTS.md, Design.

// FULL prefetch relies on a private Next.js enum. Review this import after
// Next.js upgrades. If FULL is unavailable at runtime, use standard prefetch.
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

// A click that lands on any of these (or their descendants) is left to the
// control, not hijacked into a row navigation.
export const rowInteractiveSelector =
  "a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']";

// Wait for hover intent before prefetching a row's target.
export const HOVER_PREFETCH_DELAY_MS = 120;

// Modified and auxiliary clicks do not start navigation in this tab.
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

// Navigate to href unless the click originated inside an interactive control.
// Returns whether navigation was started, so callers can gate pending state.
export function navigateRow(
  target: EventTarget | null,
  href: string,
  navigate: (href: string) => void,
): boolean {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest;
  if (typeof closest === "function" && closest.call(target, rowInteractiveSelector)) return false;
  navigate(href);
  return true;
}

// Prefetch each key once per set lifetime.
export function shouldPrefetchOnce(key: string, seen: Set<string>): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

// Cache the FULL prefetch option. If FULL is unavailable at runtime, callers
// use standard prefetch.
let cachedFullPrefetchOptions: { kind: PrefetchKind } | undefined;
let resolvedFullPrefetchOptions = false;
export function resolveFullPrefetchOptions(): { kind: PrefetchKind } | undefined {
  if (!resolvedFullPrefetchOptions) {
    resolvedFullPrefetchOptions = true;
    try {
      cachedFullPrefetchOptions = PrefetchKind.FULL ? { kind: PrefetchKind.FULL } : undefined;
    } catch {
      cachedFullPrefetchOptions = undefined;
    }
  }
  return cachedFullPrefetchOptions;
}
