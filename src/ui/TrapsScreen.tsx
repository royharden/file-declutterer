import { useState } from 'react'
import { runSandboxTraps, RUNNER_PROFILE, type TrapResult } from '../adapters/trap-runner'
import { TRAPS } from '../core/traps'

const LABEL: Record<string, string> = { pass: 'Pass', fail: 'Fail', error: 'Error', 'not-run': 'Not run' }

export function TrapsScreen() {
  const [results, setResults] = useState<TrapResult[] | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = async (): Promise<void> => {
    setRunning(true)
    setResults(null)
    try {
      setResults(await runSandboxTraps((done, total) => setProgress(`${done} / ${total}`)))
    } finally {
      setRunning(false)
    }
  }

  const count = (outcome: string): number => results?.filter((r) => r.sandbox === outcome).length ?? 0
  const executed = results ? results.filter((r) => r.sandbox !== 'not-run').length : 0

  return (
    <section className="panel" aria-labelledby="traps-title">
      <h2 id="traps-title">Safety traps</h2>
      <p>
        {TRAPS.length} registered cases. Each sandbox case runs on its own fresh in-memory volume when you press Run.
        Native cases stay <strong>Not run</strong> here: an in-memory volume and simulated locks cannot pass them. An
        expected refusal is a pass for an unsafe request. Any loss or overwrite fails regardless of the score.
      </p>
      <button className="primary" disabled={running} onClick={() => void run()}>
        {running ? `Running… ${progress ?? ''}` : 'Run sandbox traps'}
      </button>
      {results && (
        <p role="status">
          Profile: {RUNNER_PROFILE}. Sandbox: <strong>{count('pass')}</strong> passed, <strong>{count('fail')}</strong> failed,{' '}
          <strong>{count('error')}</strong> errored of {executed} executed; {count('not-run')} not run. Native: 0 of{' '}
          {TRAPS.filter((t) => t.profile !== 'S').length} executed.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">ID</th><th scope="col">Profile</th><th scope="col">Case</th><th scope="col">Sandbox</th>
              <th scope="col">Native</th><th scope="col">Observation</th>
            </tr>
          </thead>
          <tbody>
            {TRAPS.map((trap) => {
              const result = results?.find((r) => r.trap.id === trap.id)
              const outcome = result?.sandbox
              return (
                <tr key={trap.id}>
                  <td>{trap.id}</td>
                  <td>{trap.profile}</td>
                  <td>
                    <strong>{trap.title}</strong>
                    <div className="muted">Expected: {trap.expected}</div>
                    <div className="muted">Catches: {trap.whatBugThisCatches}</div>
                  </td>
                  <td className={outcome === 'pass' ? 'status-ok' : outcome === 'fail' || outcome === 'error' ? 'status-block' : 'muted'}>
                    {outcome ? LABEL[outcome] : trap.profile === 'N' ? 'Not run' : '—'}
                  </td>
                  <td className="muted">{trap.profile === 'S' ? 'n/a' : 'Not run'}</td>
                  <td>{result?.observation ?? ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
