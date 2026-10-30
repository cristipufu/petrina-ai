import { useEffect, useState } from "react";
import { normalizeRemoteChecks, REMOTE_CHECK_LIMITS, type Product } from "@petrina/core";
import { failureText, sim } from "../engine";
import { FormSection } from "./EditorPanel";

interface RemoteCheckRow {
  id: string;
  name: string;
}

export function ProductRemoteChecks({
  product,
  live,
  onState,
}: {
  product: Product;
  live: boolean;
  onState: (state: { busy: boolean; dirty: boolean }) => void;
}) {
  const saved = product.requiredRemoteChecks ?? [];
  const savedRows: RemoteCheckRow[] = saved.map((name, index) => ({ id: `remote-${index}`, name }));
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<RemoteCheckRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({});

  const values = (entries: readonly RemoteCheckRow[]) => entries.map((entry) => entry.name);
  const dirty = editing && JSON.stringify(values(rows)) !== JSON.stringify(values(savedRows));
  useEffect(() => {
    onState({ busy, dirty });
  }, [busy, dirty, onState]);

  const start = () => {
    setRows(savedRows.length ? savedRows : [{ id: "remote-0", name: "" }]);
    setRowErrors({});
    setError(undefined);
    setEditing(true);
  };

  const edit = (id: string, name: string) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, name } : row)));
    setRowErrors({});
    setError(undefined);
  };

  const save = async () => {
    if (!live || busy) return;
    const activeRows = rows.length === 1 && !rows[0]!.name.trim() && !saved.length ? [] : rows;
    const errors: Record<string, string | undefined> = {};
    for (const row of activeRows) {
      const trimmed = row.name.trim();
      const problem = !trimmed
        ? "Give this GitHub check a name."
        : activeRows.some((other) => other.id !== row.id && other.name.trim() === trimmed)
          ? "Use each GitHub check name only once."
          : undefined;
      if (problem) errors[row.id] = problem;
    }
    setRowErrors(errors);
    if (Object.keys(errors).length) {
      setError("Check the highlighted GitHub check names before saving.");
      return;
    }
    let normalized: string[];
    try {
      normalized = normalizeRemoteChecks(activeRows.map((row) => row.name));
    } catch (failure) {
      setError(failureText(failure));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await sim.setProductRemoteChecks(product.id, normalized);
      setEditing(false);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };

  const localOnly = product.repo.startsWith("local/");

  return (
    <FormSection
      title="GitHub checks before direct delivery"
      description="Check names on GitHub that must pass on the exact tested version before Petrina updates your default branch or publishes a release directly."
    >
      {editing ? (
        <>
          <div className="product-command-rows">
            {rows.map((row, index) => (
              <div key={row.id} className="product-command-row">
                <div className="product-command-fields">
                  <label className="form-field">
                    <span className="field-label">GitHub check {index + 1}</span>
                    <input
                      className="field"
                      value={row.name}
                      maxLength={REMOTE_CHECK_LIMITS.name}
                      disabled={busy}
                      placeholder="Check name as shown on GitHub"
                      aria-invalid={Boolean(rowErrors[row.id]) || undefined}
                      onChange={(event) => edit(row.id, event.target.value)}
                    />
                    {rowErrors[row.id] && <span className="error-text">{rowErrors[row.id]}</span>}
                  </label>
                </div>
                <button
                  type="button"
                  className="btn quiet"
                  disabled={busy}
                  aria-label={`Remove GitHub check ${index + 1}`}
                  onClick={() => {
                    setRows((current) => current.filter((entry) => entry.id !== row.id));
                    setRowErrors({});
                    setError(undefined);
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || rows.length >= REMOTE_CHECK_LIMITS.count}
              onClick={() =>
                setRows((current) => [...current, { id: `remote-${crypto.randomUUID()}`, name: "" }])
              }
            >
              Add GitHub check
            </button>
            <span className="setting-hint">Up to {REMOTE_CHECK_LIMITS.count} check names.</span>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn lead"
              disabled={!live || busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save GitHub checks"}
            </button>
            <button
              type="button"
              className="btn quiet"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(undefined);
                setRowErrors({});
              }}
            >
              Cancel GitHub checks
            </button>
          </div>
        </>
      ) : (
        <>
          {saved.length ? (
            <ul className="product-check-list">
              {saved.map((name) => (
                <li key={name}>
                  <strong>{name}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="setting-hint">No required GitHub checks are saved.</p>
          )}
          <div>
            <button type="button" className="btn" disabled={!live || busy} onClick={start}>
              {saved.length ? "Edit GitHub checks" : "Add GitHub checks"}
            </button>
          </div>
        </>
      )}
      {localOnly ? (
        <p className="setting-hint">Connect this product to GitHub before requiring GitHub checks.</p>
      ) : (
        <p className="setting-hint">
          Pull-request tasks continue to use GitHub’s own pull-request checks.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </FormSection>
  );
}
