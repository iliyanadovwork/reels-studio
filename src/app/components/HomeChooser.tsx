'use client';

// The app's landing screen — "What do you want to do today?" — with one entry point per reel style: a
// Reddit-thread reel, a commentary reel, or a meme reel. Each is a big card that routes into the studio
// (see page.tsx), which reads the choice as the reel style. Purely presentational; no state of its own.

export type HomeChoice = 'reddit' | 'commentary' | 'meme';

interface CardDef {
  choice: HomeChoice;
  title: string;
  sub: string;
  icon: React.ReactNode;
}

const icon = (d: React.ReactNode) => (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

const CARDS: CardDef[] = [
  {
    choice: 'reddit',
    title: 'Reddit post',
    sub: 'Turn a Reddit thread into a narrated Short — import, pick, narrate, export in bulk.',
    icon: icon(<>
      <path d="M12 8h4.5a2.5 2.5 0 0 1 0 5H12z" />
      <path d="M12 3v5" /><circle cx="18" cy="5.5" r="1.4" />
      <path d="M4 13a8 8 0 0 0 16 0" /><circle cx="9" cy="12.5" r="1" /><circle cx="15" cy="12.5" r="1" />
      <path d="M9.5 16c1.5 1 3.5 1 5 0" />
    </>),
  },
  {
    choice: 'commentary',
    title: 'Commentary post',
    sub: 'Add an AI voice-over intro (with ducked audio + synced captions) over any video.',
    icon: icon(<>
      <rect x="3" y="5" width="13" height="14" rx="2" />
      <path d="M16 9l5-3v12l-5-3z" />
      <path d="M6.5 9v3a2 2 0 0 0 4 0V9a2 2 0 0 0-4 0z" /><path d="M8.5 15.5V17" />
    </>),
  },
  {
    choice: 'meme',
    title: 'Meme post',
    sub: 'Narrate a meme or screenshot line by line over gameplay footage.',
    icon: icon(<>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </>),
  },
];

export function HomeChooser({ onPick }: { onPick: (choice: HomeChoice) => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6 py-12">
      <div className="mb-10 text-center">
        <h1 className="text-title text-[1.75rem] font-semibold text-fg">What do you want to do today?</h1>
        <p className="mt-2 text-body text-fg-3">Pick a workspace to get started.</p>
      </div>

      {/* One column per card at full width, dropping to two then one as the viewport narrows — the track
          count follows CARDS.length, so a card is never left orphaned in a dead slot. */}
      <div className="grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(c => (
          <button
            key={c.choice}
            type="button"
            onClick={() => onPick(c.choice)}
            className="focus-ring group flex flex-col items-start gap-4 rounded-xl border border-line bg-surface-1 p-6 text-left transition-all duration-[var(--dur-fast)] hover:-translate-y-1 hover:border-accent-border hover:bg-hover hover:shadow-lg"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-surface-2 text-fg-2 transition-colors group-hover:bg-accent-tint group-hover:text-accent-text">
              {c.icon}
            </span>
            <span className="flex flex-col gap-1.5">
              <span className="text-body font-semibold text-fg">{c.title}</span>
              <span className="text-caption leading-relaxed text-fg-3">{c.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
