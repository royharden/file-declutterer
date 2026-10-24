import { useEffect } from 'react'
import { isBlocked } from '../core/validate'
import type { SandboxSession } from './session'

function SideReview({ session }: { session: SandboxSession }) {
  const side = session.side
  if (!side) return null
  const plan = side.plan
  return (
    <section className="panel" aria-labelledby="side-title">
      <h2 id="side-title">{side.kind === 'quarantine' ? 'Review quarantine plan' : 'Review restore plan'}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
            {side.rows.map((row) => (
              <tr key={row.rowId}>
                <td className="mono">{row.source}</td>
                <td className="mono">{row.destination}</td>
                <td>
                  {isBlocked(row) ? <span className="status-block">Blocked</span> : <span className="status-ok">OK</span>}
                  <ul className="issues">
                    {row.issues.map((i) => (
                      <li key={i.code + i.message}>{i.message}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan && (
        <>
          <p>
            {plan.rows.length} move(s) accepted. Digest <code>{plan.digest}</code>
          </p>
          {session.sideApprovalCurrent ? (
            <p className="status-ok" role="status">Approved. Apply uses the same journal, recovery and undo as organize runs.</p>
          ) : (
            <p className="muted" role="status">Not approved.</p>
          )}
          <button className="primary" disabled={session.busy || plan.rows.length === 0 || session.sideApprovalCurrent} onClick={() => session.approveSide()}>
            Approve this exact plan
          </button>
          <button className="primary" disabled={session.busy || !session.sideApprovalCurrent || session.blockers.length > 0} onClick={() => void session.applySide()}>
            Apply {side.kind}
          </button>
          {session.blockers.map((b) => (
            <p key={b} className="status-block">{b}</p>
          ))}
        </>
      )}
    </section>
  )
}

export function DuplicatesScreen({ session }: { session: SandboxSession }) {
  useEffect(() => {
    void session.refreshRuns().then(() => session.changed())
  }, [session])
  const report = session.dupReport
  const quarantineRuns = session.runs.filter((r) => r.kind === 'quarantine' && r.status === 'committed')

  return (
    <>
      <section className="panel" aria-labelledby="dup-title">
        <h2 id="dup-title">Exact duplicates</h2>
        <p>
          Groups need equal, nonzero size and a full SHA-256 computed from the bytes. The suggested keeper is only
          highlighted; nothing is selected for you. Selected extras go to a separate quarantine plan that you review and
          approve. Nothing is ever permanently deleted.
        </p>
        <button className="primary" disabled={session.busy} onClick={() => void session.scanDuplicates()}>
          Find duplicates
        </button>
        {session.dupScan?.status === 'aborted' && <p className="notice error" role="alert">Scan aborted: {session.dupScan.abortReason}</p>}
        {report && (
          <>
            <div className="stats">
              <div className="stat"><strong>{report.groups.length}</strong>groups</div>
              <div className="stat"><strong>{report.zeroByte.length}</strong>empty (not offered)</div>
              <div className="stat"><strong>{report.unhashable.length}</strong>unhashable</div>
              <div className="stat"><strong>{report.unverified.length}</strong>unverified hash</div>
            </div>
            {report.groups.length === 0 && <p className="muted">No exact duplicates.</p>}
            {report.groups.map((group) => (
              <fieldset key={group.sha256}>
                <legend>
                  {group.members.length} copies · {group.size} bytes · SHA-256 <code>{group.sha256.slice(0, 16)}…</code>
                </legend>
                {group.members.map((member) => (
                  <div key={member.id}>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={session.dupSelected.has(member.id)}
                        onChange={(e) => session.toggleDuplicate(member.id, e.target.checked)}
                      />
                      <span className="mono">{member.relPath}</span>
                      {member.id === group.keeperSuggestion && <strong> (suggested keeper)</strong>}
                    </label>
                  </div>
                ))}
              </fieldset>
            ))}
            <p>
              <button className="primary" disabled={session.busy || session.dupSelected.size === 0} onClick={() => void session.reviewQuarantine()}>
                Review quarantine plan ({session.dupSelected.size} selected)
              </button>
            </p>
          </>
        )}
        {session.error && <p className="notice error" role="alert">{session.error}</p>}
      </section>

      <section className="panel" aria-labelledby="restore-title">
        <h2 id="restore-title">Restore from quarantine</h2>
        {quarantineRuns.length === 0 ? (
          <p className="muted">No committed quarantine runs.</p>
        ) : (
          <label className="inline">
            <span>Quarantine run</span>
            <select value={session.restoreSource?.runId ?? ''} onChange={(e) => e.target.value && void session.chooseRestoreRun(e.target.value)}>
              <option value="">Choose…</option>
              {quarantineRuns.map((r) => (
                <option key={r.runId} value={r.runId}>{r.runId} ({r.rows} file(s))</option>
              ))}
            </select>
          </label>
        )}
        {session.restoreSource && (
          <>
            {session.restoreSource.candidates.map((c) => (
              <div key={c.quarantined}>
                <label className="inline">
                  <input type="checkbox" checked={session.restoreChosen.has(c.quarantined)} onChange={(e) => session.toggleRestore(c.quarantined, e.target.checked)} />
                  <span className="mono">{c.quarantined} → {c.original}</span>
                </label>
              </div>
            ))}
            <button className="primary" disabled={session.busy || session.restoreChosen.size === 0} onClick={() => void session.reviewRestore()}>
              Review restore plan
            </button>
            <p className="muted">Restore refuses changed bytes and occupied original paths; both files are then preserved.</p>
          </>
        )}
      </section>

      <SideReview session={session} />
    </>
  )
}
