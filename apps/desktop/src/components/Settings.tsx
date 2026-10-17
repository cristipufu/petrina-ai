import { setSingleKeys, useSingleKeys } from "../keyboard";

/** Shared Settings page; other app preferences belong alongside Keyboard here. */
export function SettingsPage({ onShortcuts }: { onShortcuts: () => void }) {
  const singleKeys = useSingleKeys();
  return (
    <div className="page">
      <div className="page-head"><div><h1>Settings</h1><p>Choose how you work with Petrina.</p></div></div>
      <section className="panel">
        <h2>Keyboard</h2>
        <label className="toggle"><input type="checkbox" checked={singleKeys} onChange={(event) => setSingleKeys(event.target.checked)} />Single-key shortcuts</label>
        <p>Use J, K, P and M to work with the task in focus. These keys rest while you type.</p>
        <button className="btn" onClick={onShortcuts}>Keyboard shortcuts</button>
      </section>
    </div>
  );
}
