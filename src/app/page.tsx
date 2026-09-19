'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVideoEntries } from './hooks/useVideoEntries';
import { CanvasGrid } from './components/CanvasGrid';
import { HomeChooser, type HomeChoice } from './components/HomeChooser';
import { REEL_STYLES } from '@/lib/reelStyles';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GRID_BG_STYLE } from '@/lib/ui-constants';
import type { BrandProps } from './types';

// Standalone client-side reels studio: paste a link or upload a video, crop/trim on the timeline,
// and export MP4s. Everything persists in the browser (localStorage + IndexedDB) — no backend.

// A single local "user": the persistence hooks only need a non-null id to switch on.
const LOCAL_USER = 'local';

// Each reel style is its own DESTINATION, not a mode inside one studio: Home is the only way between them,
// so a workspace never has to know another style exists. The view IS the style — nothing reads a separate
// "which style am I" flag, which is what used to let the two leak into each other.
type AppView = 'home' | HomeChoice;

// Any registered reel style is a workspace. Read from the registry rather than listed here, so adding a
// style doesn't leave its persisted view unrecognised (which silently drops the user back to Home).
const isWorkspace = (v: string): v is HomeChoice => v in REEL_STYLES;

// Restore the persisted view BEFORE the browser paints, so a returning user doesn't see the Home landing
// flash for a frame before their workspace loads. useLayoutEffect only runs in the browser (this is a client
// component); fall back to useEffect on the server so React logs no SSR warning.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const EMPTY_BRAND: BrandProps = {
  logoSrc: '',
  logos: [],
  fonts: [],
  displayName: '',
  handle: '',
  colors: [],
};

/**
 * One style's workspace. The reels live HERE, not in the page: page.tsx keys this on the style, so opening
 * the other style remounts it with its own empty `entries`, and a reel you just pasted can't be sitting in
 * the list when the other workspace loads. (Hoisting `useVideoEntries` to the page is exactly what let a
 * commentary reel show up in the Reddit grid — one array, handed to whichever workspace was on screen.)
 */
function Workspace({ styleId, active, onGoHome }: { styleId: HomeChoice; active: boolean; onGoHome: () => void }) {
  const {
    entries, setEntries, canvasRefsMap,
    addRow, addReels, removeRow, duplicateRow, deleteAllReels, updateEntry, updateLocalVideo, handleVideoError,
    fetchVideo,
  } = useVideoEntries();

  const [restored, setRestored] = useState(false);

  return (
    <CanvasGrid
      styleId={styleId}
      entries={entries}
      setEntries={setEntries}
      canvasRefsMap={canvasRefsMap}
      brand={EMPTY_BRAND}
      onAddRow={addRow}
      onAddReels={addReels}
      onRemoveRow={removeRow}
      onDuplicateRow={duplicateRow}
      onDeleteAllReels={deleteAllReels}
      onHandleVideoError={handleVideoError}
      onUpdateEntry={updateEntry}
      onUpdateLocalVideo={updateLocalVideo}
      onFetchVideo={fetchVideo}
      userId={LOCAL_USER}
      videoMode="twitter"
      onRestored={() => setRestored(true)}
      restored={restored}
      active={active}
      onGoHome={onGoHome}
    />
  );
}

export default function Home() {
  // Landing → workspace routing. Deterministic 'home' on the server (SSR-safe); the last view is restored
  // from localStorage after mount so a reload reopens where you were, with a Home button to return.
  const [view, setView] = useState<AppView>('home');
  const viewRestored = useRef(false);
  useIsoLayoutEffect(() => {
    if (viewRestored.current) return;
    viewRestored.current = true;
    try {
      // Anything unrecognised — including the removed 'thumbnail' view — falls through to Home rather than
      // restoring a view that no longer exists. 'studio' is the pre-split single workspace: reopen it as
      // whichever style that session was last using, so a returning user lands where they left off.
      const v = localStorage.getItem('app:view');
      if (v && isWorkspace(v)) setView(v);
      else if (v === 'studio') {
        const legacy = localStorage.getItem('reels:activeStyle');
        setView(legacy && isWorkspace(legacy) ? legacy : 'reddit');
      }
    } catch { /* SSR/private */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem('app:view', view); } catch { /* quota/private */ }
  }, [view]);

  // No sidebar in this app — the element rail docks at the viewport's left edge.
  useEffect(() => {
    document.documentElement.style.setProperty('--rail-w', '0px');
  }, []);

  // The workspace that's mounted. It lags `view` by staying set while you're on Home, so stepping out and
  // back keeps the live canvas (framing, a fresh upload) instead of remounting and re-restoring it.
  const [openStyle, setOpenStyle] = useState<HomeChoice | null>(null);
  useEffect(() => { if (view !== 'home') setOpenStyle(view); }, [view]);

  return (
    <div className="flex flex-col h-screen" style={GRID_BG_STYLE}>
      <div className="flex-1 min-h-0">
        <ErrorBoundary>
          {view === 'home' && <HomeChooser onPick={setView} />}
          {/* The workspace stays MOUNTED across a trip to Home. `contents` makes this wrapper transparent to
              layout (CanvasGrid stays a direct flex child that fills the height — no clipped toolbar);
              `hidden` (display:none) keeps it MOUNTED but off-screen. Unmounting it on "Home" reset its
              framing maps and tripped the restore's `restored` skip, losing a fresh upload's video.
              `key` is the style, so picking the OTHER style remounts from scratch — a workspace is never
              reused across styles, which is what keeps one style's state from reaching the other. */}
          <div className={view !== 'home' ? 'contents' : 'hidden'}>
            {openStyle && (
              <Workspace
                key={openStyle}
                styleId={openStyle}
                active={view !== 'home'}
                onGoHome={() => setView('home')}
              />
            )}
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
