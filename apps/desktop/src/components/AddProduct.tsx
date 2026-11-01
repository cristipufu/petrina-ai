import { useEffect, useId, useRef, useState } from "react";
import { EditorPanel, FormSection } from "./EditorPanel";
import { FolderGit2 } from "lucide-react";
import { suggestProductName } from "@petrina/core";
import { failureText, sim, useEngineStatus, useSim } from "../engine";
import { ConfirmDialog, WaitingLine } from "./bits";

/**
 * Add a product from a local clone of its GitHub repository. A clone linked to GitHub opens on the
 * board right away. One that is already added, or not linked to GitHub, says so first, as first run does.
 * `waiting`: a notification's item that opens once this closes.
 */
export function AddProductDialog({ waiting, onClose, onAdded }: { waiting?: string; onClose: () => void; onAdded: (productId: string) => void }) {
  const id = useId();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [findChecks, setFindChecks] = useState(true);
  const state = useSim();
  const status = useEngineStatus();
  const live = status.link === "live";
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<{ id: string; already: boolean }>();
  const product = added && state.products.find((entry) => entry.id === added.id);
  const note = product && (added.already || product.delivery === "local");
  const [discard, setDiscard] = useState(false);
  const close = () => {
    if (!busy && !picking) {
      if (!added && (path || name)) setDiscard(true);
      else onClose();
    }
  };

  const done = useRef(onAdded);
  done.current = onAdded;
  useEffect(() => {
    if (product && !note) done.current(product.id);
  }, [product, note]);

  // Set at once, so a second Enter or click before the first answer never sends the same folder twice.
  const sending = useRef(false);
  const add = async () => {
    if (!path.trim() || !name.trim() || !live || sending.current || added) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const before = new Set(sim.getState().products.map((entry) => entry.id));
      const id = String(await sim.addProduct(path.trim(), name));
      const already = before.has(id);
      if (!already && findChecks) {
        await Promise.resolve(sim.discoverProductChecks?.(id)).catch(() => undefined);
      }
      setAdded({ id, already });
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const edit = (change: () => void) => {
    change();
    setAdded(undefined);
    setError(undefined);
  };
  const chooseFolder = async () => {
    if (busy || picking || !live || sending.current) return;
    setPicking(true);
    setError(undefined);
    try {
      const chosen = await sim.pickFolder();
      if (!chosen) return;
      edit(() => {
        setPath(chosen);
        setName(suggestProductName(chosen));
      });
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <EditorPanel title="Add a product" description="Connect a local repository so your agents can work on it." icon={<FolderGit2 size={24} />} busy={busy || picking} onClose={close} footer={<>

          <button className="btn quiet" disabled={busy || picking} onClick={close}>
            {note ? "Close" : "Cancel"}
          </button>
          <span className="spacer" />
          {note ? (
            <button key="done" className="btn lead" autoFocus onClick={() => onAdded(product.id)}>
              {added.already ? "Show it" : "Done"}
            </button>
          ) : (
            <button key="add" className="btn lead" disabled={!path.trim() || !name.trim() || busy || picking || !live || !!added} onClick={() => void add()}>
              {busy || added ? "Adding…" : "Add product"}
            </button>
          )}
      </>}>
        <WaitingLine text={waiting} />
        <FormSection title="Repository" description="Choose an existing local clone. Agents work in separate copies, so your clone stays untouched.">
          <div className="form-field">
            <label className="field-label" htmlFor={`${id}-folder`}>
              Folder of the local clone
            </label>
            <div className="paste-row">
              <input
                id={`${id}-folder`}
                autoFocus
                className="field"
                aria-label="Folder of the local clone"
                aria-describedby={`${id}-folder-help`}
                placeholder="~/code/my-product"
                value={path}
                onChange={(event) =>
                  edit(() => {
                    setPath(event.target.value);
                    setName(suggestProductName(event.target.value));
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void add();
                }}
              />
              <button
                className="btn"
                type="button"
                disabled={busy || picking || !live}
                onClick={() => void chooseFolder()}
              >
                {picking ? "Choosing…" : "Choose folder…"}
              </button>
            </div>
          </div>
          <p className="hint" id={`${id}-folder-help`}>
            Choose a folder or paste its path from Finder or your terminal.
          </p>
        </FormSection>
        <FormSection title="Product details" description="The name your squad uses throughout Petrina.">
          <label className="form-field"><span className="field-label">Name</span><input
            className="field"
            value={name}
            placeholder="My product"
            onChange={event => edit(() => setName(event.target.value))}
            onKeyDown={event => { if (event.key === "Enter") void add(); }}
          /></label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={findChecks}
              disabled={busy || picking || !!added}
              onChange={(event) => setFindChecks(event.target.checked)}
            />
            Find automated checks now
          </label>
          <p className="hint">Queues the Check finder right away so checks are ready before your first task reaches review.</p>
        </FormSection>
        {!live && <p className="muted" role="status">Waiting for the engine before adding a product.</p>}
        {error && (
          <p className="error-text form-feedback" role="alert">
            {error}
          </p>
        )}
        {note && (
          <p className="product-added" role="status">
            {added.already ? (
              <>
                <strong>{product.name}</strong> is already added.
              </>
            ) : (
              <>
                <strong>{product.name}</strong> is added, and since it isn't linked to GitHub, its finished work stays on this machine instead of becoming a pull request.
              </>
            )}
          </p>
        )}
      </EditorPanel>
      {discard && <ConfirmDialog
        title="Discard product changes?"
        confirm="Discard changes"
        cancel="Keep editing"
        onCancel={() => setDiscard(false)}
        onConfirm={onClose}
      ><p>This product has not been added. Your unsaved choices will be lost.</p></ConfirmDialog>}
    </>
  );
}
