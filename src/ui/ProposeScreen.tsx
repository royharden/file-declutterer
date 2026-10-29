import type { SandboxSession } from './session'

export function ProposeScreen({ session, onReview }: { session: SandboxSession; onReview: () => void }) {
  const ready = session.canPropose
  return (
    <section className="panel" aria-labelledby="propose-title">
      <h2 id="propose-title">Propose</h2>
      {!ready && <p className="notice warn">Run a complete scan on Home / Scan first.</p>}
      <p>
        Proposals only suggest a trusted category and a name without extension. Code builds every destination and
        reattaches the exact original extension. Nothing moves until you review, approve and apply.
      </p>
      <div>
        <button className="primary" disabled={!ready || session.busy} onClick={() => void session.propose('heuristic').then(onReview)}>
          Heuristic (extension rules)
        </button>
        <button className="secondary" disabled={!ready || session.busy} onClick={() => void session.propose('simulated').then(onReview)}>
          Simulated AI example
        </button>
      </div>
      <ul className="muted">
        <li>
          <strong>Heuristic</strong> sorts by known extension and keeps the original name. It is not AI. Unknown types go
          to Other with low confidence and start unselected.
        </li>
        <li>
          <strong>Simulated AI example</strong> replays a fixed, pre-written response in the model contract, including a
          few deliberately invalid items so you can see them rejected. No model is called. Every row it produces is
          labelled "simulated".
        </li>
        <li>
          Real local AI is available only in the local CLI with an explicitly configured loopback model. The hosted page
          never calls a model.
        </li>
      </ul>
      {session.proposalFatal && (
        <p className="notice error" role="alert">
          Response rejected as a whole: {session.proposalFatal} No proposals were created.
        </p>
      )}
    </section>
  )
}
