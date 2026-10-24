import { useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { ApplyScreen } from './ApplyScreen'
import { ProposeScreen } from './ProposeScreen'
import { ReviewScreen } from './ReviewScreen'
import { RunsScreen } from './RunsScreen'
import { ScanScreen } from './ScanScreen'
import { SandboxSession } from './session'

export type TabId = 'scan' | 'propose' | 'review' | 'apply' | 'runs' | 'duplicates' | 'traps' | 'settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'scan', label: 'Home / Scan' },
  { id: 'propose', label: 'Propose' },
  { id: 'review', label: 'Review / Approve' },
  { id: 'apply', label: 'Apply / Recovery' },
  { id: 'runs', label: 'Runs / Undo' },
]

function useSession(session: SandboxSession): number {
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.version,
  )
}

export function App() {
  const session = useMemo(() => new SandboxSession(), [])
  useSession(session)
  const [tab, setTab] = useState<TabId>('scan')

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!
    setTab(next.id)
    document.getElementById(`tab-${next.id}`)?.focus()
  }

  return (
    <>
      <div className="banner" role="note">
        Sandbox — simulated file operations; no disk changes
      </div>
      <header className="app-header">
        <h1>File Declutterer</h1>
        <nav className="tabs" role="tablist" aria-label="Sandbox steps">
          {TABS.map((t, index) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'scan' && <ScanScreen session={session} />}
        {tab === 'propose' && <ProposeScreen session={session} onReview={() => setTab('review')} />}
        {tab === 'review' && <ReviewScreen session={session} onApply={() => setTab('apply')} />}
        {tab === 'apply' && <ApplyScreen session={session} onRuns={() => setTab('runs')} />}
        {tab === 'runs' && <RunsScreen session={session} />}
      </main>
    </>
  )
}
