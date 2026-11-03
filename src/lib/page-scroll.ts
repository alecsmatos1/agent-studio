// Where the reader scrolled an artifact's page (requested 2026-11-03), as its sandboxed preview
// reports it (`artifact-preview.html`): each scrolled element by its child indexes from the
// page's root element, the page itself with none, and how far it is scrolled. The viewer keeps
// the latest report with its chat (`src/lib/chat-recall.ts`) and hands it back to the page each
// time it loads, so the page opens again where the reader left it. A report is telemetry only:
// it changes nothing but where the page opens.

/** One scrolled element of a page. */
export type PageScroll = { path: number[]; x: number; y: number };

/** The places a preview reports, when `data` is a report from the frame given `token`. */
export function pageScrollReport(data: unknown, token: string): PageScroll[] | undefined {
  if (!token || typeof data !== 'object' || data === null) return;
  const report = data as { type?: unknown; token?: unknown; places?: unknown };
  if (report.type !== 'studio-artifact-scroll' || report.token !== token) return;
  if (!Array.isArray(report.places)) return;
  const places: PageScroll[] = [];
  for (const place of report.places as unknown[]) {
    if (typeof place !== 'object' || place === null) return;
    const { path, x, y } = place as { path?: unknown; x?: unknown; y?: unknown };
    if (!Array.isArray(path) || !path.every((index) => Number.isSafeInteger(index) && index >= 0))
      return;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x + y)) return;
    places.push({ path: [...(path as number[])], x, y });
  }
  return places;
}
