"use client";

import { useEffect, useRef, useState } from "react";

import { HelpDemoFrame } from "@/components/help/help-demo-frame";
import { helpDemos } from "@/components/help/help-demos";
import {
  activeHelpSectionId,
  findHelpEntryId,
  helpEntries,
  helpEntryId,
  helpGroups,
} from "@/lib/help/registry";
import { cn } from "@/lib/utils";

const SCROLL_OFFSET = 120;
const SCROLL_STORAGE_KEY = "pulse-help-scroll";
const firstSectionId = helpEntryId(helpEntries[0]!);

export function HelpCenter() {
  const documentRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const activeRef = useRef<string>(firstSectionId);
  const [active, setActive] = useState<string>(firstSectionId);
  const [missingAnchor, setMissingAnchor] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const known = findHelpEntryId(hash);
      if (known) {
        activeRef.current = known;
        queueMicrotask(() => setActive(known));
      } else {
        window.history.replaceState(null, "", window.location.pathname);
        queueMicrotask(() => setMissingAnchor(true));
      }
    } else {
      const saved = Number(window.sessionStorage.getItem(SCROLL_STORAGE_KEY));
      if (Number.isFinite(saved) && saved > 0) window.scrollTo(0, saved);
    }
    restoredRef.current = true;
  }, []);

  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const container = documentRef.current;
      if (!container) return;
      const positions = Array.from(container.querySelectorAll("section[data-help-section]")).map(
        (section) => ({
          id: section.id,
          top: section.getBoundingClientRect().top + window.scrollY,
        }),
      );
      const next = activeHelpSectionId(positions, window.scrollY, SCROLL_OFFSET);
      if (next && next !== activeRef.current) {
        activeRef.current = next;
        if (restoredRef.current && window.location.hash !== `#${next}`) {
          window.history.replaceState(null, "", `#${next}`);
        }
        setActive(next);
      }
      window.sessionStorage.setItem(SCROLL_STORAGE_KEY, String(Math.round(window.scrollY)));
    };

    const requestMeasure = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    const followHash = () => {
      const known = findHelpEntryId(window.location.hash);
      if (known && known !== activeRef.current) {
        activeRef.current = known;
        setActive(known);
      }
    };

    window.addEventListener("scroll", requestMeasure, { passive: true });
    window.addEventListener("resize", requestMeasure);
    window.addEventListener("hashchange", followHash);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestMeasure);
      window.removeEventListener("resize", requestMeasure);
      window.removeEventListener("hashchange", followHash);
    };
  }, []);

  return (
    <div className="lg:flex lg:gap-12">
      <aside className="hidden lg:block lg:w-[220px] lg:shrink-0">
        <nav aria-label="Help sections" className="hide-scrollbar sticky top-20 max-h-[calc(100vh-96px)] overflow-y-auto pb-8">
          {helpGroups.map((group) => (
            <div key={group.label} className="mb-6">
              <p className="mb-2 text-[11px] font-medium tracking-[0.04em] text-[var(--fg-faint)] uppercase">
                {group.label}
              </p>
              <ul className="space-y-px">
                {group.entries.map((entry) => {
                  const id = helpEntryId(entry);
                  const current = active === id;
                  return (
                    <li key={id}>
                      <a
                        href={`#${id}`}
                        aria-current={current ? "location" : undefined}
                        className={cn(
                          "block rounded-[6px] px-2.5 py-1.5 text-[13px] text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
                          current && "bg-[var(--hover)] font-medium text-[var(--fg)]",
                        )}
                      >
                        {entry.title}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Help</h1>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            Concepts and guides with live examples
          </p>
        </div>
        <div className="sticky top-14 z-30 -mx-6 mb-6 border-b border-[var(--border)] bg-[color:var(--bg)]/95 px-6 py-3 backdrop-blur lg:hidden">
          <label className="flex items-center gap-3 text-[13px] text-[var(--fg-muted)]">
            <span className="shrink-0">Jump to</span>
            <select
              value={active}
              onChange={(event) => {
                window.location.hash = `#${event.target.value}`;
              }}
              className="h-9 w-full min-w-0 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 text-[13px] text-[var(--fg)]"
            >
              {helpGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.entries.map((entry) => (
                    <option key={helpEntryId(entry)} value={helpEntryId(entry)}>
                      {entry.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>

        {missingAnchor ? (
          <p role="status" className="mb-6 rounded-[8px] border border-[var(--border-strong)] bg-[var(--chip-bg)] px-4 py-3 text-[13px] text-[var(--fg-muted)]">
            Linked section not found — browse all topics below
          </p>
        ) : null}

        <div ref={documentRef}>
          {helpGroups.map((group) => (
            <div key={group.label} className="mb-12 last:mb-0">
              <h2 className="mb-6 text-[11px] font-semibold tracking-[0.08em] text-[var(--fg-faint)] uppercase">
                {group.label}
              </h2>
              <div className="space-y-12">
                {group.entries.map((entry) => {
                  const id = helpEntryId(entry);
                  const demo = helpDemos[entry.demo];
                  return (
                    <section
                      key={id}
                      id={id}
                      data-help-section
                      aria-labelledby={`${id}-title`}
                      className="scroll-mt-32 lg:scroll-mt-24"
                    >
                      <h3 id={`${id}-title`} className="text-base font-semibold tracking-[-0.32px]">
                        <a href={`#${id}`} className="hover:underline">
                          {entry.title}
                        </a>
                      </h3>
                      <p className="mt-2 max-w-[640px] text-[13px] leading-[19px] text-[var(--fg-muted)]">
                        {entry.summary}
                      </p>
                      {entry.steps ? (
                        <ol className="mt-3 max-w-[640px] list-decimal space-y-1.5 pl-5 text-[13px] leading-[19px]">
                          {entry.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      ) : null}
                      <HelpDemoFrame label={demo.label} className="mt-4 max-w-[640px]">
                        <demo.Demo />
                      </HelpDemoFrame>
                      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                        {entry.relatedLinks.map((link) => (
                          <li key={link.href}>
                            <a
                              href={link.href}
                              className="text-[13px] font-medium text-[var(--fg)] hover:underline"
                            >
                              {link.label} <span aria-hidden="true">→</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
