import { useEffect, useState } from 'react'
import type { JournalRecord } from '../core/journal-codec'
import { ReportView } from './ApplyScreen'
import type { SandboxSession } from './session'

function JournalViewer({ session, runId }: { session: SandboxSession; runId: string }) {
  const [data, setData] = useState<{ records: JournalRecord[]; problem: string | null; torn: boolean } | null>(null)
  useEffect(() => {
    void session.journalRecords(runId).then(setData)
  }, [session, runId, session.version])
  if (!data) return <p className="muted">Loading journal…</p>
  return (
    <div>
      {data.problem && <p className="status-block">Journal needs attention: {data.problem}</p>}
      {data.torn && <p className="status-warn">The journal ends with a torn fragment (tolerated; continued before the next append).</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Seq</th><th scope="col">Type</th><th scope="col">Phase</th><th scope="col">Op</th>
              <th scope="col">Paths</th><th scope="col">Result</th><th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.seq}>
                <td>{r.seq}</td>
                <td>{r.type}</td>
                <td>{r.phase ?? ''}</td>
                <td>{r.op ? `${r.op}${r.opIndex !== null ? ` #${r.opIndex}` : ''}` : ''}</td>
                <td className="mono">{r.from ? `${r.from} → ${r.to ?? ''}` : r.to ?? ''}</td>
                <td>{r.result ?? r.status ?? ''}</td>
                <td>{r.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function RunsScreen({ session }: { session: SandboxSession }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [editPath, setEditPath] = useState('')
  useEffect(() => {
    void session.refreshRuns().then(() => session.changed())
  }, [session])
  const runs = session.runs

  return (
    <>
      <section className="panel" aria-labelledby="runs-title">
        <h2 id="runs-title">Runs</h2>
        {runs.length === 0 && <p className="muted">No runs yet.</p>}
        {runs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Run</th><th scope="col">Kind</th><th scope="col">Rows</th><th scope="col">Status</th><th scope="col">Undo</th><th scope="col">Detail</th></tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const blockers = session.undoBlockersFor(run.runId)
                  return (
                    <tr key={run.runId}>
                      <td className="mono">{run.runId}</td>
                      <td>{run.kind}{run.restoreOf ? ` of ${run.restoreOf}` : ''}</td>
                      <td>{run.rows}</td>
                      <td className={run.status === 'committed' ? 'status-ok' : run.status === 'needs_attention' || run.status === 'open' ? 'status-block' : ''}>
                        {run.status}{run.phase && run.status !== 'committed' ? ` (${run.phase})` : ''}
                      </td>
                      <td>
                        {blockers.length === 0 ? (
                          <button className="secondary" disabled={session.busy} onClick={() => void session.previewUndo(run.runId)}>Preview undo</button>
                        ) : run.status === 'committed' ? (
                          <span className="muted">{blockers[0]}</span>
                        ) : (
                          <span className="muted">Not undoable</span>
                        )}
                      </td>
                      <td>
                        <button className="secondary" onClick={() => setSelected(selected === run.runId ? null : run.runId)} aria-expanded={selected === run.runId}>
                          {selected === run.runId ? 'Hide journal' : 'Show journal'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          Undo reverses only the latest committed run. A newer committed run, such as a quarantine or restore, must be
          undone first; the reason is shown beside the older run.
        </p>
      </section>

      {session.preview && (
        <section className="panel" aria-labelledby="preview-title">
          <h2 id="preview-title">Undo preview for {session.preview.runId}</h2>
          <p>Each file is checked again now. Changed or missing files are refused and preserved; safe reversals proceed.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Move</th><th scope="col">Action</th><th scope="col">Why</th></tr>
              </thead>
              <tbody>
                {session.preview.entries.map((e) => (
                  <tr key={e.opIndex}>
                    <td className="mono">{e.from} → {e.to}</td>
                    <td className={e.action === 'refuse' ? 'status-block' : 'status-ok'}>{e.action}</td>
                    <td>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="danger" disabled={session.busy} onClick={() => void session.undo(session.preview!.runId)}>
            Confirm undo
          </button>
          <button className="secondary" onClick={() => { session.preview = null; session.changed() }}>Cancel</button>
        </section>
      )}

      {session.lastReport && (
        <section className="panel" aria-labelledby="last-title">
          <h2 id="last-title">Last result</h2>
          <ReportView report={session.lastReport} />
        </section>
      )}

      <section className="panel" aria-labelledby="sim-title">
        <h2 id="sim-title">Simulate an external edit</h2>
        <p className="muted">Change a file's bytes as another program would, then preview undo to see it refused and preserved.</p>
        <label className="inline">
          <span>Sandbox path</span>
          <select value={editPath} onChange={(e) => setEditPath(e.target.value)}>
            <option value="">Choose a file…</option>
            {session.fs.allPaths().filter((p) => p.kind === 'file').map((p) => (
              <option key={p.path} value={p.path}>{p.path}</option>
            ))}
          </select>
        </label>
        <button className="secondary" disabled={!editPath} onClick={() => session.simulateExternalEdit(editPath)}>Edit bytes</button>
        {session.error && <p className="notice error" role="alert">{session.error}</p>}
      </section>

      {selected && (
        <section className="panel" aria-labelledby="journal-title">
          <h2 id="journal-title">Journal {selected}</h2>
          <JournalViewer session={session} runId={selected} />
        </section>
      )}
    </>
  )
}
