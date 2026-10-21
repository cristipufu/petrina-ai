import { useEffect, useRef, useState } from "react";
import { EditorPanel } from "./EditorPanel";
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
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const state = useSim();
  const status = useEngineStatus();
  const live = status.link === "live";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<{ id: string; already: boolean }>();
  const product = added && state.products.find((entry) => entry.id === added.id);
  const note = product && (added.already || product.delivery === "local");
  const [discard, setDiscard] = useState(false);
  const close = () => { if (!busy) { if (!added && (path || name)) setDiscard(true); else onClose(); } };

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
      setAdded({ id, already: before.has(id) });
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

  return (
    <>
      <EditorPanel title="Add a product" description="Point Petrina at a local clone of the product's GitHub repository." icon={<FolderGit2 size={24} />} busy={busy} onClose={close} footer={<>

          <span className="spacer" />
          <button className="btn quiet" disabled={busy} onClick={close}>
            {note ? "Close" : "Cancel"}
          </button>
          {note ? (
            <button key="done" className="btn lead" autoFocus onClick={() => onAdded(product.id)}>
              {added.already ? "Show it" : "Done"}
            </button>
          ) : (
            <button key="add" className="btn lead" disabled={!path.trim() || !name.trim() || busy || !live || !!added} onClick={() => void add()}>
              {busy || added ? "Adding…" : "Add product"}
            </button>
          )}
      </>}>
        <WaitingLine text={waiting} />
        <label className="product-field">
          Folder of the local clone
          <input
            autoFocus
            className="field"
            aria-label="Folder of the local clone"
            placeholder="/Users/you/code/my-product"
            value={path}
            onChange={(event) => edit(() => {
              setPath(event.target.value);
              setName(suggestProductName(event.target.value));
            })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
          />
        </label>
        <label className="product-field">
          Name
          <input
            className="field"
            value={name}
            onChange={(event) => edit(() => setName(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
          />
        </label>
        {!live && <p className="muted" role="status">Waiting for the engine before adding a product.</p>}
        {error && (
          <p className="error-text" role="alert" style={{ margin: "4px 0 8px" }}>
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
        <p className="note">Each task gets its own working copy, so your clone stays untouched.</p>
      </EditorPanel>
      {discard && <ConfirmDialog title="Discard product changes?" confirm="Discard changes" cancel="Keep editing" onCancel={() => setDiscard(false)} onConfirm={onClose}><p>This product has not been added. Your unsaved choices will be lost.</p></ConfirmDialog>}
    </>
  );
}
