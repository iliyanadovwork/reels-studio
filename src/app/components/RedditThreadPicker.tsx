'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from './ui';
import { CheckIcon } from '@/lib/icons';
import { fmtTime } from '@/lib/utils';
import { SHORTS_MAX_SECONDS, estimateNarrationSeconds } from '@/lib/reelDuration';
import { ttsClean } from '@/lib/ttsClean';
import { assembleScriptItems, writeCommentEdit, writeFieldEdit } from '@/lib/redditThreadEdits';
import type { RedditThreadEdits } from './TikTokCanvas/types';
import {
  groupComments, loadMore, resolveReadTarget, cleanChanges, threadEstimateText,
  effectiveTitle, effectivePara, effectiveComment, commentIsEdited,
  recordHistory, undoHistory, redoHistory, emptyHistory,
  type PickableThread, type ImportedRedditComment, type EditHistory, type ReadTarget,
} from '@/lib/redditPicker';

// ── The Reddit thread picker ────────────────────────────────────────────────────────────────────────
// ONE picking surface for ONE thread, rendered by BOTH hosts: the canvas rail flyout (attaches the card to
// the selected reel) and the pipeline's bulk builder (one reel per thread, a tab each). It owns everything
// about picking — the comment list with its groups/paging/replies, the reading pane, the editable script
// preview, "Clean text", undo/redo — and NOTHING about where the picks go: the hosts own the thread state,
// their own persistence and their own action buttons. Two copies of this UI is exactly the divergence this
// codebase keeps paying for, so there is only ever one.
// Its decidable rules live in lib/redditPicker.ts (unit-tested, no DOM).

const COMMENTS_PER_PAGE = 8;

function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

/** Inline editor for one thread text item (title / paragraph / comment). Cmd/Ctrl-Enter saves,
    Escape cancels; committing text identical to the original clears the override. */
function ThreadEditBox({ label, draft, setDraft, onSave, onCancel, rows = 4 }: {
  label: string; draft: string; setDraft: (s: string) => void; onSave: () => void; onCancel: () => void; rows?: number;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-sm border border-accent-border bg-surface-2 p-1.5">
      <span className="text-caption text-fg-3">Editing {label} — the card, narration and copy all use this text</span>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); }
        }}
        rows={rows}
        autoFocus
        className="focus-ring w-full resize-y rounded-sm border border-line bg-surface-1 px-1.5 py-1 text-caption text-fg"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={onSave}>Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <span className="text-caption text-fg-4">⌘↵ save · esc cancel · matching the original clears the edit</span>
      </div>
    </div>
  );
}

/** One inline-editable field in the Preview (assembled script). Uncontrolled (defaultValue) so typing
    never re-renders the thread list; commits on blur. The PARENT keys it by item so switching threads /
    re-selecting remounts it with the current edited-or-original text. */
function PreviewField({ label, defaultValue, edited, onSave, rows = 3 }: {
  label: string; defaultValue: string; edited?: boolean; onSave: (v: string) => void; rows?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-fg-3">{label}{edited && <span className="text-accent-text"> · edited</span>}</span>
      <textarea
        defaultValue={defaultValue}
        onBlur={e => { if (e.target.value !== defaultValue) onSave(e.target.value); }}   // only on a real change (no spurious edit/undo step)
        rows={rows}
        className="focus-ring w-full resize-y rounded-md border border-line bg-surface-1 px-2 py-1.5 text-body text-fg leading-relaxed"
      />
    </div>
  );
}

export function RedditThreadPicker({ threadKey, thread, speed, onToggle, onEdits }: {
  /** Identity of the thread on screen (its url). Switching it resets the transient picking state — reading
      pane, open editor, expanded replies, undo history — so a stale index from another thread can never
      show or commit, and it gives each thread its own load-more position. */
  threadKey: string;
  thread: PickableThread;
  /** Narration speed — scales the live length estimate shown while picking. */
  speed: number;
  onToggle: (kind: 'c' | 'p', idx: number) => void;
  /** Functional update, so the host stays the single owner of the thread's edits. */
  onEdits: (fn: (prev: RedditThreadEdits) => RedditThreadEdits) => void;
}) {
  const [reading, setReading] = useState<ReadTarget | null>(null);          // comment/para shown full-text in the reading pane
  const [editing, setEditing] = useState<{ kind: 't' | 'c' | 'p'; idx: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [paneView, setPaneView] = useState<'reading' | 'preview'>('reading');   // right pane: single item vs the full editable script
  const [expandedReplies, setExpandedReplies] = useState<Set<number>>(new Set());   // top-comment idxs whose replies are shown
  // The image src that failed to DISPLAY (not to arrive). Holding the src rather than a boolean means a
  // different thread's image gets a fresh attempt without any reset plumbing.
  const [imgFailed, setImgFailed] = useState<string | null>(null);
  const [shownByKey, setShownByKey] = useState<Record<string, number>>({});   // per-thread # of comment groups shown (load-more)
  // Remount token for the uncontrolled preview fields (their defaultValue only applies on mount): bump it
  // after "Clean text" or undo/redo so they show the new text.
  const [cleanGen, setCleanGen] = useState(0);

  // Reset the reading pane + any open editor when the thread changes.
  useEffect(() => { setReading(null); setEditing(null); setExpandedReplies(new Set()); }, [threadKey]);

  // ── Undo / redo for this thread's text edits (field edits + "Clean text"). Text only — SELECTION isn't
  //    tracked. RedditThreadEdits are written immutably (the pure writers return new objects), so
  //    snapshotting a reference is a snapshot. The stack algebra lives in lib/redditPicker (tested). ──
  const history = useRef<EditHistory<RedditThreadEdits>>(emptyHistory());
  const [histFlags, setHistFlags] = useState({ canUndo: false, canRedo: false });
  const refreshHist = () => setHistFlags({ canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 });
  // Snapshot the CURRENT edits BEFORE a mutation — called once per user action (one "Clean text" = one step).
  const recordEdits = () => { history.current = recordHistory(history.current, thread.edits); refreshHist(); };
  const undoEdits = () => {
    const { history: h, restored } = undoHistory(history.current, thread.edits);
    history.current = h;
    if (restored === undefined) return;
    onEdits(() => restored);
    setCleanGen(g => g + 1);   // remount the uncontrolled preview fields to show the restored text
    refreshHist();
  };
  const redoEdits = () => {
    const { history: h, restored } = redoHistory(history.current, thread.edits);
    history.current = h;
    if (restored === undefined) return;
    onEdits(() => restored);
    setCleanGen(g => g + 1);
    refreshHist();
  };
  // Latest undo/redo held in refs so the (stable) window keydown listener always calls the current closure.
  // Written in an effect (not during render) so an abandoned concurrent render can't publish a stale closure.
  const undoRef = useRef(undoEdits);
  const redoRef = useRef(redoEdits);
  useEffect(() => { undoRef.current = undoEdits; redoRef.current = redoEdits; });
  // History is per-thread — clear it on a thread switch (separate effect so it sits after the refs above).
  useEffect(() => { history.current = emptyHistory(); setHistFlags({ canUndo: false, canRedo: false }); }, [threadKey]);
  // Cmd/Ctrl+Z = undo, +Shift = redo — but only while NOT typing in a field (let the browser do native
  // char-level undo inside a textarea/input). Scoped by mount: both hosts unmount the picker when closed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redoRef.current(); else undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openEdit = (kind: 't' | 'c' | 'p', idx: number) => {
    setEditing({ kind, idx });
    setDraft(kind === 't' ? effectiveTitle(thread) : kind === 'p' ? effectivePara(thread, idx) : effectiveComment(thread, idx));
  };
  // The single write path for a text edit (reading-mode box AND the inline preview fields both call it),
  // so keying/normalisation/clear-on-match can't diverge between the two surfaces. All three field kinds
  // funnel through the shared, tested pure writers (content-anchored comment slots; index-keyed
  // title/paragraph with normalisation + clear-on-match + drift anchor).
  const saveEdit = (kind: 't' | 'c' | 'p', idx: number, value: string) => {
    onEdits(prev => kind === 'c'
      ? writeCommentEdit(thread.comments, idx, value, prev)
      : writeFieldEdit(kind, kind === 't' ? thread.post.title : (thread.paragraphs[idx] ?? ''), value, idx, prev));
  };
  const commitEdit = () => {
    if (!editing) return;
    recordEdits();   // one undo step per committed edit
    saveEdit(editing.kind, editing.idx, draft);
    setEditing(null);
  };
  // Apply the narrator cleaner to every editable field, stored as edits — so the visible text, the card AND
  // the voice all get the cleaned version. Idempotent (re-clean = no-op, hence no spurious undo step).
  const cleanThread = () => {
    const changes = cleanChanges(assembleScriptItems(thread), ttsClean);
    if (!changes.length) return;
    recordEdits();   // one undo step for the whole clean
    for (const ch of changes) saveEdit(ch.kind, ch.idx, ch.text);
    setCleanGen(g => g + 1);
  };

  const est = estimateNarrationSeconds(threadEstimateText(thread), speed);
  const over = est > SHORTS_MAX_SECONDS;
  const groups = groupComments(thread.comments);
  const shown = shownByKey[threadKey] ?? COMMENTS_PER_PAGE;
  const { remaining, count: loadCount, nextShown } = loadMore(groups.length, shown, COMMENTS_PER_PAGE);
  const isReading = (kind: 'c' | 'p', idx: number) => reading?.kind === kind && reading.idx === idx;

  const commentRow = (c: ImportedRedditComment, idx: number, isReply: boolean) => (
    <button key={`c${idx}`} type="button"
      onClick={() => { onToggle('c', idx); setReading({ kind: 'c', idx }); }}
      onMouseEnter={() => setReading({ kind: 'c', idx })} onFocus={() => setReading({ kind: 'c', idx })}
      className={`flex items-start gap-2 px-1.5 py-1 rounded-sm text-left w-full ${isReply ? 'ml-5' : ''} ${thread.selectedComments.has(idx) ? 'bg-active' : isReading('c', idx) ? 'bg-hover' : 'hover:bg-hover'}`}>
      <span className={`mt-0.5 flex items-center justify-center size-3.5 shrink-0 rounded-[3px] border ${thread.selectedComments.has(idx) ? 'bg-action border-action text-action-fg' : 'border-line-strong text-transparent'}`}><CheckIcon size={9} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-caption text-fg truncate">
          {isReply && <span aria-hidden className="text-fg-3 mr-1">↳</span>}
          {c.user.name}{c.isOP ? ' · OP' : ''}{isReply ? ' · reply' : ''}
          {commentIsEdited(thread, idx) && <span className="text-accent-text"> · edited</span>}
        </span>
        <span className="text-caption text-fg-3 line-clamp-2">{effectiveComment(thread, idx)}</span>
      </span>
    </button>
  );

  // The reading pane's item: pinned to an open editor, else whatever the list last pointed at.
  const target = resolveReadTarget({ editing, reading, commentCount: thread.comments.length, paraCount: thread.paragraphs.length });

  return (
    <div className="flex min-h-0 flex-1">
      {/* LEFT — comment list. Rows stay tick-to-select; hovering/focusing (or clicking) a row also
          streams its full text into the reading pane on the right. Bodies clamp to 2 lines here. */}
      <div className="w-2/5 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-1 border-r border-line">
        {editing?.kind === 't' ? (
          <div className="pb-1"><ThreadEditBox label="Title" draft={draft} setDraft={setDraft} onSave={commitEdit} onCancel={() => setEditing(null)} rows={2} /></div>
        ) : (
          <div className="flex items-start gap-1 text-caption text-fg font-medium leading-snug pb-1">
            <span className="min-w-0 flex-1">
              {thread.post.user.name} · {effectiveTitle(thread)}
              {thread.edits.title?.trim() && <span className="text-accent-text"> · edited</span>}
            </span>
            <button type="button" onClick={() => openEdit('t', 0)} aria-label="Edit title" title="Tweak the title text"
              className="focus-ring shrink-0 rounded-sm p-0.5 text-fg-4 hover:text-fg hover:bg-hover"><PencilIcon size={11} /></button>
          </div>
        )}
        {/* The post's image, if it has one. Not selectable and not narratable — it is held by a silent dwell
            at export, not read out — but it has to be VISIBLE here, or there is no way to tell whether the
            extractor found a picture until you have already built the card.

            DELIBERATELY UNDECORATED — no wrapper, no border, no rounding, no overflow-hidden, no
            object-fit, sized by the width ATTRIBUTE. This exact configuration is the only one that
            painted on a Chrome build whose compositor silently dropped the image inside an
            `overflow-hidden rounded-*` wrapper while reporting a correctly painted rect (nat=960x696
            rect=368x160 disp=block vis=visible op=1 — and nothing on screen). Two "obvious" stylings
            failed invisibly there; a plain <img width> provably did not. Decoration is not worth a
            preview that renders as nothing on some machines, so keep this boring. */}
        {thread.post.image && (
          imgFailed === thread.post.image ? (
            // An undecodable <img> renders at ZERO height with an empty alt — the picture looks ABSENT
            // when it is present and merely un-drawable. That ambiguity cost a long debugging session:
            // "no image extracted" and "image extracted but not painted" must never look the same again.
            <p className="mb-1 text-[11px] leading-snug text-warning-text">
              The post’s image arrived but couldn’t be displayed here. It is still on the card and in
              the export — this is a preview-only problem.
            </p>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={thread.post.image} alt="" width={240}
              onError={() => setImgFailed(thread.post.image ?? null)}
              className="mx-auto mb-1 block"
            />
          )
        )}
        {thread.paragraphs.map((p, pi) => (
          <button key={`p${pi}`} type="button"
            onClick={() => { onToggle('p', pi); setReading({ kind: 'p', idx: pi }); }}
            onMouseEnter={() => setReading({ kind: 'p', idx: pi })} onFocus={() => setReading({ kind: 'p', idx: pi })}
            className={`flex items-start gap-2 px-1.5 py-1 rounded-sm text-left ${thread.selectedParas.has(pi) ? 'bg-active' : isReading('p', pi) ? 'bg-hover' : 'hover:bg-hover'}`}>
            <span className={`mt-0.5 flex items-center justify-center size-3.5 shrink-0 rounded-[3px] border ${thread.selectedParas.has(pi) ? 'bg-action border-action text-action-fg' : 'border-line-strong text-transparent'}`}><CheckIcon size={9} /></span>
            <span className="min-w-0 flex-1 text-caption text-fg-3 line-clamp-2">
              {thread.edits.paras?.[pi]?.trim() && <span className="text-accent-text">edited · </span>}Post: {effectivePara(thread, pi)}
            </span>
          </button>
        ))}
        {groups.slice(0, shown).map(g => {
          const expanded = expandedReplies.has(g.top);
          const addedReplies = g.replies.filter(r => thread.selectedComments.has(r)).length;
          return (
            <div key={g.top} className="flex flex-col">
              {commentRow(thread.comments[g.top], g.top, false)}
              {g.replies.length > 0 && (
                <button type="button"
                  onClick={() => setExpandedReplies(prev => { const n = new Set(prev); if (n.has(g.top)) n.delete(g.top); else n.add(g.top); return n; })}
                  className="ml-5 mt-0.5 self-start flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-caption text-fg-3 hover:text-fg hover:bg-hover">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden
                    style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}><path d="m9 18 6-6-6-6" /></svg>
                  {expanded ? 'Hide' : 'View'} {g.replies.length} {g.replies.length === 1 ? 'reply' : 'replies'}
                  {addedReplies > 0 && <span className="text-accent-text">· {addedReplies} added</span>}
                </button>
              )}
              {expanded && g.replies.map(r => commentRow(thread.comments[r], r, true))}
            </div>
          );
        })}
        {remaining > 0 && (
          <button type="button" onClick={() => setShownByKey(v => ({ ...v, [threadKey]: nextShown }))}
            className="mt-1 self-center px-3 py-1.5 rounded-md text-caption text-fg-2 hover:bg-hover border border-line">
            Load {loadCount} more comment{remaining === 1 ? '' : 's'} · {remaining} left
          </button>
        )}
        {groups.length === 0 && <span className="text-caption text-fg-3 px-1.5">No usable comments in that thread.</span>}
      </div>

      {/* RIGHT — Reading (one item) vs Preview (the full editable script). */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex items-center gap-1 px-4 pt-3 pb-2 shrink-0">
          {(['reading', 'preview'] as const).map(v => (
            <button key={v} type="button" onClick={() => { setEditing(null); setPaneView(v); }}
              className={`rounded-md px-2.5 py-1 text-caption font-medium transition-colors ${paneView === v ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover'}`}>
              {v === 'reading' ? 'Reading' : 'Preview & edit'}
            </button>
          ))}
          {/* Undo / redo this thread's text edits (incl. Clean text). Also Cmd/Ctrl+Z / +Shift+Z. */}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={undoEdits} disabled={!histFlags.canUndo} title="Undo text edit (⌘/Ctrl+Z)" aria-label="Undo"
              className="rounded-md px-2 py-1 text-caption text-fg-2 hover:bg-hover disabled:opacity-40 disabled:pointer-events-none">Undo</button>
            <button type="button" onClick={redoEdits} disabled={!histFlags.canRedo} title="Redo text edit (⌘/Ctrl+Shift+Z)" aria-label="Redo"
              className="rounded-md px-2 py-1 text-caption text-fg-2 hover:bg-hover disabled:opacity-40 disabled:pointer-events-none">Redo</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {paneView === 'preview' ? (() => {
          // ONE source of truth for the script (order + edited text) — the same shape used to reason
          // about what's fed. Each item carries its (kind, idx) so onSave routes to the right override.
          const items = assembleScriptItems(thread);
          const hasBody = items.some(it => it.kind !== 't');
          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-caption text-fg-3">The full narration script — edit any field; it feeds the card, voice & copy.</span>
                <div className="flex items-center gap-2 shrink-0">
                  <button type="button" onClick={cleanThread}
                    title="Fix wording for the AI narrator — strip links / emojis / stray symbols and de-shout ALL-CAPS. Updates the card too; you can still edit after."
                    className="text-caption text-fg-2 border border-line-strong rounded-md px-2 py-1 hover:bg-hover whitespace-nowrap">
                    Clean text
                  </button>
                  {est > 0 && (
                    <span className={`text-caption tabular-nums ${over ? 'text-danger-text font-medium' : 'text-fg-3'}`}
                      title={over ? 'Estimated over the 3:00 YouTube Shorts limit' : 'Estimated final length'}>
                      ~{fmtTime(over ? Math.ceil(est) : est)}{over ? ' · over 3:00' : ''}
                    </span>
                  )}
                </div>
              </div>
              {items.map(it => it.editable ? (
                <PreviewField key={`${threadKey}:${it.kind}:${it.idx}:${cleanGen}`} label={it.label}
                  defaultValue={it.text} edited={it.edited} onSave={v => { recordEdits(); saveEdit(it.kind, it.idx, v); }}
                  rows={it.kind === 't' ? 2 : 3} />
              ) : (
                // Fallback for any non-editable field (none today — title, paragraphs and all comments
                // incl. replies are editable). Kept as a defensive render so a field can't silently no-op.
                <div key={`${threadKey}:${it.kind}:${it.idx}:${cleanGen}`} className="flex flex-col gap-1">
                  <span className="text-caption text-fg-3">{it.label} <span className="text-fg-4">· not editable</span></span>
                  <p className="text-body text-fg-2 whitespace-pre-wrap break-words leading-relaxed">{it.text}</p>
                </div>
              ))}
              {!hasBody && (
                <p className="text-caption text-fg-3">Only the title so far — tick paragraphs or comments on the left to add them to the script.</p>
              )}
            </div>
          );
        })() : (() => {
          if (!target) return <p className="text-caption text-fg-3">This thread has no comments to read.</p>;
          if (target.kind === 'p') {
            const p = thread.paragraphs[target.idx];
            if (p == null) return null;
            const selected = thread.selectedParas.has(target.idx);
            const isEditing = editing?.kind === 'p' && editing.idx === target.idx;
            return (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption text-fg font-medium">Post body{thread.edits.paras?.[target.idx]?.trim() && <span className="text-accent-text"> · edited</span>}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!isEditing && <button type="button" onClick={() => openEdit('p', target.idx)} className="px-2 py-1 rounded-md text-caption border border-line-strong text-fg-2 hover:bg-hover">Edit text</button>}
                    <button type="button" onClick={() => onToggle('p', target.idx)}
                      className={`px-2.5 py-1 rounded-md text-caption ${selected ? 'bg-action text-action-fg' : 'border border-line-strong text-fg-2 hover:bg-hover'}`}>
                      {selected ? 'Added ✓' : 'Add to reel'}
                    </button>
                  </div>
                </div>
                {isEditing
                  ? <ThreadEditBox label={`Paragraph ${target.idx + 1}`} draft={draft} setDraft={setDraft} onSave={commitEdit} onCancel={() => setEditing(null)} rows={6} />
                  : <p className="text-body text-fg-2 whitespace-pre-wrap break-words leading-relaxed">{effectivePara(thread, target.idx)}</p>}
              </div>
            );
          }
          const c = thread.comments[target.idx];
          if (!c) return null;
          const isReply = (c.depth ?? 0) > 0;
          const selected = thread.selectedComments.has(target.idx);
          const isEditing = editing?.kind === 'c' && editing.idx === target.idx;
          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption text-fg font-medium min-w-0 truncate">
                  {isReply && <span aria-hidden className="text-fg-3 mr-1">↳</span>}
                  {c.user.name}{c.isOP ? ' · OP' : ''}{isReply ? ' · reply' : ''}{c.score ? ` · ${c.score}` : ''}{c.timeAgo ? ` · ${c.timeAgo}` : ''}
                  {commentIsEdited(thread, target.idx) && <span className="text-accent-text"> · edited</span>}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Comments — top-level AND replies — are editable: edits are content-anchored, not keyed by depth. */}
                  {!isEditing && <button type="button" onClick={() => openEdit('c', target.idx)} className="px-2 py-1 rounded-md text-caption border border-line-strong text-fg-2 hover:bg-hover">Edit text</button>}
                  <button type="button" onClick={() => onToggle('c', target.idx)}
                    className={`px-2.5 py-1 rounded-md text-caption ${selected ? 'bg-action text-action-fg' : 'border border-line-strong text-fg-2 hover:bg-hover'}`}>
                    {selected ? 'Added ✓' : 'Add to reel'}
                  </button>
                </div>
              </div>
              {isEditing
                ? <ThreadEditBox label={`${c.user.name}'s comment`} draft={draft} setDraft={setDraft} onSave={commitEdit} onCancel={() => setEditing(null)} rows={6} />
                : <p className="text-body text-fg-2 whitespace-pre-wrap break-words leading-relaxed">{effectiveComment(thread, target.idx)}</p>}
            </div>
          );
        })()}
        </div>
      </div>
    </div>
  );
}
