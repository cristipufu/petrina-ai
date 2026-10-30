import { useEffect, useState } from "react";
import { CHECK_SETUP_LIMITS, commandText, commandInputText, normalizeCheckPrerequisites, parseCommand, type Product } from "@petrina/core";
import { failureText, sim } from "../engine";
import { FormSection } from "./EditorPanel";
import { ProductCommandRows, hasOpenCommandQuote, type ProductCommandRow, type ProductCommandErrors } from "./ProductCommandRows";

export function ProductCheckSetup({ product, live, onState }: {
  product: Product;
  live: boolean;
  onState: (state: {
  busy: boolean;
  dirty: boolean
}) => void
}) {
  const saved = product.checkSetup?.requirements ?? [];
  const savedRows = saved.map(requirement => ({ id: requirement.id, name: requirement.name, command: commandInputText(requirement.argv) }));
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<ProductCommandRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [rowErrors, setRowErrors] = useState<ProductCommandErrors>({});
  const dirty = editing && JSON.stringify(rows) !== JSON.stringify(savedRows);
  useEffect(() => { onState({ busy, dirty }); }, [busy, dirty, onState]);
  const start = () => {
    setRows(savedRows);
    setError(undefined);
    setRowErrors({});
    setEditing(true);
  };
  const edit = (
    id: string,
    update: Partial<ProductCommandRow>
  ) => {
    setRows(current => current.map(row => row.id === id ? {
    ...row,
    ...update
  } : row));
    setRowErrors({});
    setError(undefined);
  };
  const save = async () => {
    if (!live || busy) return;
    const errors: typeof rowErrors = {};
    for (const row of rows) {
      const name = row.name.trim();
      const nameError = !name ? "Give this requirement a name." : rows.some(other => other.id !== row.id && other.name.trim() === name) ? "Use a different name for each requirement." : undefined;
      const commandError = !row.command.trim() ? "Enter a command for this requirement." : hasOpenCommandQuote(row.command) ? "Close the quotation mark in this command." : !parseCommand(row.command)[0]?.trim() ? "Start with the program to run." : undefined;
      if (nameError || commandError) errors[row.id] = { name: nameError, command: commandError };
    }
    setRowErrors(errors);
    if (Object.keys(errors).length) {
      setError("Check the highlighted requirements before saving.");
      return;
    }
    let requirements;
    try { requirements = normalizeCheckPrerequisites(rows.map(row => ({ id: row.id, name: row.name, argv: parseCommand(row.command) }))); }
    catch (failure) {
      setError(failureText(failure));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await sim.setProductCheckSetup(product.id, requirements);
      setEditing(false);
    }
    catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  };
  return <FormSection title="Local setup" description="Read-only commands that identify the tools this product needs before its automated checks.">
    {editing ? <>
      <ProductCommandRows kind="requirement" rows={rows} busy={busy} errors={rowErrors} nameLimit={CHECK_SETUP_LIMITS.name}
        onEdit={edit} onRemove={id => {
          setRows(current => current.filter(row => row.id !== id));
          setRowErrors({});
          setError(undefined);
        }} />
      <div className="row-actions"><button
        type="button"
        className="btn"
        disabled={busy || rows.length >= CHECK_SETUP_LIMITS.count}
        onClick={() => setRows(current => [
        ...current,
        {
        id: `setup-${crypto.randomUUID()}`,
        name: "",
        command: ""
      }
      ])}
      >Add requirement</button><span className="setting-hint">Up to {CHECK_SETUP_LIMITS.count} requirements.</span></div>
      <p className="setting-hint">A program and its arguments, run directly. Saving records the requirements without running them.</p>
      <div className="row-actions"><button
        type="button"
        className="btn lead"
        disabled={!live || busy}
        onClick={() => void save()}
      >{busy ? "Saving…" : "Save local setup"}</button><button
        type="button"
        className="btn quiet"
        disabled={busy}
        onClick={() => {
        setEditing(false);
        setError(undefined);
        setRowErrors({});
      }}
      >Cancel local setup</button></div>
    </> : <>
      {saved.length ? <ul className="product-check-list">{saved.map(requirement => <li key={requirement.id}><strong>{requirement.name}</strong><span className="product-check-command mono">{commandText(requirement.argv)}</span></li>)}</ul> : <p className="setting-hint">No local setup requirements are saved.</p>}
      <div><button
        type="button"
        className="btn"
        disabled={!live || busy}
        onClick={start}
      >{product.checkSetup ? "Edit local setup" : "Add local setup"}</button></div>
    </>}
    <p className="setting-hint">Changes apply to unfinished work and require fresh verification.</p>
    {error && <p className="error-text" role="alert">{error}</p>}
  </FormSection>;
}
