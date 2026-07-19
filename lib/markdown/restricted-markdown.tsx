import "server-only";

import { renderRestrictedMarkdown } from "./restricted";

type RestrictedMarkdownProps = {
  markdown: string;
  className?: string;
};

/**
 * Server component rendering restricted markdown (announcements, status-report
 * update bodies) as sanitized HTML. The renderer escapes all HTML before
 * applying markdown, so the injected string only ever contains whitelisted tags.
 */
export function RestrictedMarkdown({ markdown, className }: RestrictedMarkdownProps) {
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: renderRestrictedMarkdown(markdown) }}
    />
  );
}
