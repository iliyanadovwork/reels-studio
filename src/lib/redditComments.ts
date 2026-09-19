// Pure comment-tree selection for the thread import — WHICH raw comments to keep, in what order, at what
// depth. Kept out of the API route so it's unit-testable (the route only adds formatting + the usable
// filter). v1: top-level comments, each immediately followed by its DIRECT replies (depth 1), capped per
// comment and overall so one comment / a huge thread can't blow the budget. Deeper replies are dropped.

export interface RawCommentNode {
  kind: string;
  data: { replies?: { data?: { children?: RawCommentNode[] } } | '' } & Record<string, unknown>;
}

export interface SelectedComment<D> { data: D; depth: number }

export function selectComments<D extends RawCommentNode['data']>(
  children: RawCommentNode[] | undefined,
  isUsable: (d: D) => boolean,
  opts: { maxComments: number; repliesPerComment: number },
): SelectedComment<D>[] {
  const out: SelectedComment<D>[] = [];
  if (!Array.isArray(children)) return out;
  for (const child of children) {
    if (out.length >= opts.maxComments) break;
    if (child?.kind !== 't1') continue;
    const d = child.data as D;
    if (!isUsable(d)) continue;
    out.push({ data: d, depth: 0 });
    // ALL usable direct replies (depth 1), in order, up to the per-comment cap.
    const replies = typeof child.data.replies === 'object' ? child.data.replies?.data?.children : undefined;
    if (Array.isArray(replies)) {
      let kept = 0;
      for (const rc of replies) {
        if (out.length >= opts.maxComments || kept >= opts.repliesPerComment) break;
        if (rc?.kind !== 't1') continue;
        const rd = rc.data as D;
        if (!isUsable(rd)) continue;
        out.push({ data: rd, depth: 1 });
        kept++;
      }
    }
  }
  return out;
}
