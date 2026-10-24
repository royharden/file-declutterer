import { useRef, useState } from 'react'
import { CATEGORIES } from '../core/proposal-schema'
import { hasWarning, isBlocked, type PlanRow } from '../core/validate'
import type { SandboxSession } from './session'
import { describeTree, predictTree } from './tree'

function RowStatus({ row }: { row: PlanRow }) {
  if (row.noop) return <span className="muted">No change (skipped)</span>
  if (isBlocked(row)) return <span className="status-block">Blocked</span>
  if (hasWarning(row)) return <span className="status-warn">Warning</span>
  return <span className="status-ok">OK</span>
}

function RowEditor({ session, row }: { session: SandboxSession; row: PlanRow }) {
  const [open, setOpen] = useState(false)
  const [categoryId, setCategoryId] = useState(row.categoryId ?? 'other')
  const [basename, setBasename] = useState(row.basename ?? '')
  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)} disabled={session.busy} aria-label={`Edit destination for ${row.source}`}>
        Edit
      </button>
    )
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void session.editRow(row.rowId, categoryId, basename).then(() => setOpen(false))
      }}
    >
      <label className="inline">
        <span>Category</span>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.folder}</option>
          ))}
        </select>
      </label>
      <label className="inline">
        <span>Name (no extension)</span>
        <input type="text" value={basename} onChange={(e) => setBasename(e.target.value)} maxLength={200} />
      </label>
      <button className="primary" type="submit" disabled={session.busy}>Save edit</button>
      <button className="secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  )
}

export function ReviewScreen({ session, onApply }: { session: SandboxSession; onApply: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const rows = session.rows
  const plan = session.plan
  const counts = {
    total: rows.length,
    selected: rows.filter((r) => r.included).length,
    blocked: rows.filter(isBlocked).length,
    warnings: rows.filter((r) => !isBlocked(r) && hasWarning(r)).length,
  }

  const download = (): void => {
    const text = session.exportPlanJson()
    if (!text || !plan) return
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${plan.planId}.move-plan.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <section className="panel" aria-labelledby="review-title">
        <h2 id="review-title">Review</h2>
        {rows.length === 0 && <p className="notice warn">No proposals yet. Use Propose first, or import a plan below.</p>}
        {session.proposalSource && (
          <p>
            Source: <strong>{session.proposalSource === 'simulated' ? 'Simulated AI example (fixtures, no model)' : session.proposalSource === 'heuristic' ? 'Heuristic (not AI)' : 'Imported / manual'}</strong>
            {session.batchId && <span className="muted"> · batch {session.batchId}</span>}
          </p>
        )}
        <div className="stats" aria-live="polite">
          <div className="stat"><strong>{counts.total}</strong>rows</div>
          <div className="stat"><strong>{counts.selected}</strong>selected</div>
          <div className="stat"><strong>{counts.warnings}</strong>warnings</div>
          <div className="stat"><strong>{counts.blocked}</strong>blocked</div>
        </div>
        {rows.length > 0 && (
          <div>
            <button className="secondary" onClick={() => void session.selectClean()} disabled={session.busy}>Select rows without issues</button>
            <button className="secondary" onClick={() => void session.clearSelection()} disabled={session.busy}>Clear selection</button>
          </div>
        )}
        {session.rejected.length > 0 && (
          <div className="notice warn">
            <strong>{session.rejected.length} proposal item(s) rejected.</strong> Rejected items are never mapped or repaired;
            the affected rows are blocked until you edit them.
            <ul className="issues">
              {session.rejected.map((r) => (
                <li key={r.index}>
                  item {r.index} {r.fileId ? `(${r.fileId})` : ''}: {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Proposed moves</caption>
              <thead>
                <tr>
                  <th scope="col">Include</th>
                  <th scope="col">Original</th>
                  <th scope="col">Exact destination</th>
                  <th scope="col">Source</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Status and issues</th>
                  <th scope="col">Edit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.rowId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={row.included}
                        disabled={session.busy || isBlocked(row) || row.noop}
                        onChange={(e) => void session.setIncluded(row.rowId, e.target.checked)}
                        aria-label={`Include ${row.source}`}
                      />
                    </td>
                    <td className="mono">{row.source}</td>
                    <td className="mono">{row.destination ?? '—'}</td>
                    <td>{row.provenance}</td>
                    <td>{row.confidence === null ? '—' : row.confidence.toFixed(2)}</td>
                    <td>
                      <RowStatus row={row} />
                      {row.reason && <div className="muted">Reason: {row.reason}</div>}
                      {row.issues.length > 0 && (
                        <ul className="issues">
                          {row.issues.map((issue) => (
                            <li key={issue.code + issue.message} className={issue.severity === 'block' ? 'status-block' : 'status-warn'}>
                              {issue.severity === 'block' ? 'Blocked' : 'Warning'}: {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td><RowEditor session={session} row={row} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {plan && (
        <section className="panel" aria-labelledby="approve-title">
          <h2 id="approve-title">Approve</h2>
          <p>
            Accepted diff: <strong>{plan.rows.length}</strong> move(s). Digest <code>{plan.digest}</code>
          </p>
          {plan.rows.length === 0 ? (
            <p className="muted">Select at least one row without blocks to approve.</p>
          ) : (
            <ol className="mono">
              {plan.rows.map((op) => (
                <li key={op.fileId}>
                  {op.from} → {op.to}
                </li>
              ))}
            </ol>
          )}
          {session.approvalCurrent ? (
            <p className="status-ok" role="status">
              Approved digest {session.approval?.digest.slice(0, 16)}… at {session.approval?.approvedAt}. Any edit clears this approval.
            </p>
          ) : (
            <p className="muted" role="status">Not approved. Approval binds exactly this digest.</p>
          )}
          <button className="primary" onClick={() => session.approveCurrent()} disabled={session.busy || plan.rows.length === 0 || session.approvalCurrent}>
            Approve this exact plan
          </button>
          {session.approvalCurrent && (
            <>
              <button className="secondary" onClick={() => session.revokeApproval()}>Revoke approval</button>
              <button className="primary" onClick={onApply}>Go to Apply</button>
            </>
          )}
          <button className="secondary" onClick={download} disabled={plan.rows.length === 0}>Export plan JSON</button>
          <h3>Before and after</h3>
          <div className="columns">
            <div>
              <h4>Before</h4>
              <pre className="tree">{describeTree(session.fs.allPaths())}</pre>
            </div>
            <div>
              <h4>After (predicted)</h4>
              <pre className="tree">{describeTree(predictTree(session.fs.allPaths(), plan.rows))}</pre>
            </div>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="import-title">
        <h2 id="import-title">Import a plan for review</h2>
        <p className="muted">
          Imported plans are never executed directly. Sandbox organize plans are rebuilt against the current scan and need
          a fresh selection and approval; native plans are shown read-only.
        </p>
        <label className="inline">
          <span>Plan JSON file</span>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > 4 * 1024 * 1024) {
                session.error = 'Plan file is larger than 4 MiB.'
                session.changed()
                return
              }
              void file.text().then((text) => session.importPlan(text))
              if (fileInput.current) fileInput.current.value = ''
            }}
          />
        </label>
        {session.imported && (
          <div className="notice">
            <p>
              Imported plan {session.imported.plan.planId} ({session.imported.plan.profile}, {session.imported.plan.kind}, {session.imported.plan.rows.length} rows). {session.imported.note}
            </p>
            {session.imported.unmatched.length > 0 && (
              <ul className="issues">
                {session.imported.unmatched.map((u) => (
                  <li key={u.from}><span className="mono">{u.from}</span>: {u.reason}</li>
                ))}
              </ul>
            )}
            {session.imported.plan.profile === 'native' && (
              <ol className="mono">
                {session.imported.plan.rows.map((op) => (
                  <li key={op.fileId}>{op.from} → {op.to}</li>
                ))}
              </ol>
            )}
          </div>
        )}
        {session.error && <p className="notice error" role="alert">{session.error}</p>}
      </section>
    </>
  )
}
