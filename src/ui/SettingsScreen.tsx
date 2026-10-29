import { useState } from 'react'
import { checkComponent } from '../core/paths'
import { CATEGORIES } from '../core/proposal-schema'
import type { SandboxSession } from './session'

export function SettingsScreen({ session }: { session: SandboxSession }) {
  const [output, setOutput] = useState(session.config.outputRoot)
  const check = checkComponent(output)
  const reserved = output.toLowerCase() === session.config.quarantineRoot.toLowerCase()
  return (
    <>
      <section className="panel" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (check.ok && !reserved) void session.setOutputRoot(output)
          }}
        >
          <label className="inline">
            <span>Output folder</span>
            <input type="text" value={output} onChange={(e) => setOutput(e.target.value)} maxLength={120} />
          </label>
          <button className="primary" type="submit" disabled={!check.ok || reserved || session.busy}>Save</button>
        </form>
        {!check.ok && <p className="status-block">Not a valid folder name: {check.reason}.</p>}
        {reserved && <p className="status-block">That name is reserved for quarantine.</p>}
        <p className="muted">
          Changing the output folder rebuilds every destination, revalidates the plan and clears any approval. Quarantine
          folder: <code>{session.config.quarantineRoot}</code>.
        </p>
        <h3>Trusted categories</h3>
        <ul>
          {CATEGORIES.map((c) => (
            <li key={c.id}>
              <strong>{c.folder}</strong> <span className="muted">({c.id})</span> {c.extensions.join(' ')}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel" aria-labelledby="help-title">
        <h2 id="help-title">Help</h2>
        <ul>
          <li>The sandbox lives only in this page. Reset or reload discards it.</li>
          <li>Proposals never name paths. Code builds every destination and keeps the exact original extension.</li>
          <li>Warnings start unselected. Blocked rows cannot be selected until you edit them.</li>
          <li>Approval binds a digest of the exact accepted rows, output folder and root. Any change clears it.</li>
          <li>Apply writes a journal record before and after every change. Recovery and undo look at the files again and refuse anything changed, missing or foreign.</li>
          <li>Swaps, case-only renames and moves onto paths another selected file leaves are not supported.</li>
          <li>There is no delete. Duplicates go to a quarantine folder you can restore from.</li>
          <li>
            Native mode is a local command-line tool built from this repository. It needs one explicit, unmanaged local NTFS
            folder and stays read-only until its platform qualification passes. See the README.
          </li>
        </ul>
      </section>
    </>
  )
}
