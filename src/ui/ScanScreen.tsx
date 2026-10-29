import type { SandboxSession } from './session'
import { describeTree } from './tree'

const BLOCKED = new Set(['unhashable', 'link-or-reparse', 'multiply-linked'])

export function ScanScreen({ session }: { session: SandboxSession }) {
  const scan = session.scan
  return (
    <>
      <section className="panel" aria-labelledby="home-title">
        <h2 id="home-title">Sandbox workspace</h2>
        <p>
          This page holds about forty small synthetic files in memory. You review every proposed move, the whole
          plan is validated and bound to a digest before apply, and a write-ahead journal drives recovery and undo.
          Nothing here touches your disk. Reloading the page discards the sandbox.
        </p>
        <button className="primary" onClick={() => void session.runScan()} disabled={session.busy}>
          {session.busy ? 'Scanning…' : scan ? 'Rescan' : 'Scan sandbox'}
        </button>
        <button className="secondary" onClick={() => session.reset()} disabled={session.busy}>
          Reset sandbox
        </button>
        <details>
          <summary>Native mode (local CLI)</summary>
          <p className="muted">
            Real files are changed only by the local command-line tool, built from this repository and run on your own
            machine against one explicit, unmanaged local folder. Native writes stay disabled until platform
            qualification passes. The browser never reads or writes your folders.
          </p>
        </details>
        {session.error && (
          <p className="notice error" role="alert">
            Scan failed: {session.error}
          </p>
        )}
      </section>
      {scan && (
        <section className="panel" aria-labelledby="scan-title">
          <h2 id="scan-title">Scan {scan.scanId}</h2>
          {scan.status === 'aborted' ? (
            <p className="notice error" role="alert">
              Scan aborted: {scan.abortReason} No partial result can be approved.
            </p>
          ) : (
            <p className="status-ok">Scan complete.</p>
          )}
          <div className="stats">
            <div className="stat"><strong>{scan.totals.eligibleFiles}</strong>eligible files</div>
            <div className="stat"><strong>{scan.totals.eligibleBytes}</strong>eligible bytes</div>
            <div className="stat"><strong>{scan.totals.skipped}</strong>skipped</div>
            <div className="stat"><strong>{scan.totals.blocked}</strong>blocked</div>
            <div className="stat"><strong>{scan.totals.zeroByte}</strong>zero-byte</div>
            <div className="stat"><strong>{scan.totals.projectTrees}</strong>project trees untouched</div>
          </div>
          <p className="muted">
            Bounds: at most {scan.bounds.maxFiles} files, {scan.bounds.maxEntries} entries, depth {scan.bounds.maxDepth}.
            Encountered {scan.totals.encounteredEntries} entries.
          </p>
          <div className="columns">
            <div>
              <h3>Eligible files</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th scope="col">Path</th><th scope="col">Size</th><th scope="col">SHA-256</th></tr>
                  </thead>
                  <tbody>
                    {scan.files.map((file) => (
                      <tr key={file.id}>
                        <td className="mono">{file.relPath}</td>
                        <td>{file.size === 0 ? 'empty' : file.size}</td>
                        <td className="mono" title={file.sha256 ?? ''}>{file.sha256?.slice(0, 12)}…</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3>Skipped and blocked</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th scope="col">Path</th><th scope="col">Reason</th></tr>
                  </thead>
                  <tbody>
                    {scan.skipped.map((skip) => (
                      <tr key={skip.relPath}>
                        <td className="mono">{skip.relPath}{skip.kind === 'dir' ? '/' : ''}</td>
                        <td>
                          <span className={BLOCKED.has(skip.reason) ? 'status-block' : 'muted'}>
                            {BLOCKED.has(skip.reason) ? 'Blocked' : 'Skipped'}: {skip.reason}
                          </span>{' '}
                          {skip.detail}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Current tree</h3>
              <pre className="tree" aria-label="Sandbox tree">{describeTree(session.fs.allPaths())}</pre>
            </div>
          </div>
        </section>
      )}
    </>
  )
}
