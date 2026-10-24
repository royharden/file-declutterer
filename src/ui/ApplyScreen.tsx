import { useEffect, useState } from 'react'
import type { RunReport } from '../core/runs'
import type { SandboxSession } from './session'
import { describeTree } from './tree'

export function ReportView({ report }: { report: RunReport }) {
  return (
    <div className="notice" role="status">
      <p>
        Run <code>{report.runId}</code> ({report.kind}) is <strong>{report.status}</strong>
        {report.phase ? ` after ${report.phase}` : ''}.
      </p>
      {report.haltReason && <p className="status-block">Halted: {report.haltReason}</p>}
      {report.journalProblem && <p className="status-block">Journal needs attention: {report.journalProblem}</p>}
      <p>
        Requested {report.counts.requested} · applied {report.counts.applied} · reversed {report.counts.reversed} · unresolved{' '}
        {report.counts.unresolved} · skipped/unchanged {report.counts.skipped}
      </p>
      {report.entries.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th scope="col">#</th><th scope="col">Operation</th><th scope="col">Result</th><th scope="col">Detail</th></tr>
            </thead>
            <tbody>
              {report.entries.map((e) => (
                <tr key={`${e.opIndex}-${e.state}`}>
                  <td>{e.opIndex}</td>
                  <td className="mono">{e.op === 'move' ? `${e.from} → ${e.to}` : `folder ${e.to}`}</td>
                  <td className={e.state === 'unresolved' ? 'status-block' : e.state === 'retained' ? 'status-warn' : 'status-ok'}>{e.state}</td>
                  <td>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function ApplyScreen({ session, onRuns }: { session: SandboxSession; onRuns: () => void }) {
  const [interrupt, setInterrupt] = useState('')
  useEffect(() => {
    void session.refreshRuns().then(() => session.changed())
  }, [session])
  const plan = session.plan
  const unresolved = session.runs.filter((r) => r.status === 'open' || r.status === 'needs_attention')
  const canApply = plan !== null && session.approvalCurrent && session.blockers.length === 0 && !session.busy

  return (
    <>
      {unresolved.length > 0 && (
        <section className="panel" aria-labelledby="recovery-title">
          <h2 id="recovery-title">Recovery required</h2>
          <p>New work is blocked until these runs are resolved.</p>
          {unresolved.map((run) => (
            <div key={run.runId} className="notice warn">
              <p>
                Run <code>{run.runId}</code> ({run.kind}) is <strong>{run.status === 'open' ? 'interrupted' : 'needs attention'}</strong>
                {run.phase ? ` during ${run.phase}` : ''}.{run.problem ? ` ${run.problem}` : ''}
                {run.torn ? ' The journal ends with a torn record; it will be preserved and continued before recovery appends.' : ''}
              </p>
              {run.phase === 'undo' ? (
                <button className="primary" disabled={session.busy} onClick={() => void session.undo(run.runId)}>Retry undo</button>
              ) : (
                <button className="primary" disabled={session.busy} onClick={() => void session.rollback(run.runId)}>
                  Recover (roll back)
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="panel" aria-labelledby="apply-title">
        <h2 id="apply-title">Apply</h2>
        {!plan || plan.rows.length === 0 ? (
          <p className="notice warn">No approved plan. Propose, review and approve first.</p>
        ) : !session.approvalCurrent ? (
          <p className="notice warn">The current plan is not approved, or it changed after approval. Approve it on Review.</p>
        ) : (
          <p>
            Ready to apply <strong>{plan.rows.length}</strong> approved move(s), digest <code>{plan.digest.slice(0, 16)}…</code>
          </p>
        )}
        {session.blockers.map((b) => (
          <p key={b} className="status-block">{b}</p>
        ))}
        <fieldset>
          <legend>Interruption injection (sandbox demonstration)</legend>
          <p className="muted">
            Stop the next apply, recovery or undo at boundary N (each journal write and each file-system change is a
            boundary). This demonstrates the recovery reducers inside this page; it is not evidence of process-crash recovery.
          </p>
          <label className="inline">
            <span>Interrupt at boundary</span>
            <input type="number" min={1} value={interrupt} onChange={(e) => setInterrupt(e.target.value)} style={{ width: '6em' }} />
          </label>
          <button className="secondary" onClick={() => session.setInterrupt(interrupt ? Number(interrupt) : null)}>
            Arm
          </button>
          <button className="secondary" onClick={() => { setInterrupt(''); session.setInterrupt(null) }}>Disarm</button>
          <span className="muted">{session.interruptAt ? `Armed at boundary ${session.interruptAt}.` : 'Not armed.'}</span>
        </fieldset>
        <p>
          <button className="primary" disabled={!canApply} onClick={() => void session.applyApproved()}>
            Apply approved plan
          </button>
          <button className="secondary" onClick={onRuns}>Runs and undo</button>
        </p>
        {session.lastInterrupt && <p className="notice error" role="alert">{session.lastInterrupt}</p>}
        {session.boundaries.length > 0 && (
          <details>
            <summary>Boundaries reached in the last action ({session.boundaries.length})</summary>
            <ol className="mono">
              {session.boundaries.map((b, i) => (
                <li key={`${i}-${b}`}>{b}</li>
              ))}
            </ol>
          </details>
        )}
        {session.lastReport && <ReportView report={session.lastReport} />}
        {session.error && <p className="notice error" role="alert">{session.error}</p>}
      </section>

      <section className="panel" aria-labelledby="state-title">
        <h2 id="state-title">Sandbox files now</h2>
        <pre className="tree">{describeTree(session.fs.allPaths())}</pre>
      </section>
    </>
  )
}
