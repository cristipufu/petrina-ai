import { useRef, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { suggestProductName } from "@petrina/core";
import { sim, useEngineStatus } from "../engine";
import { useFocusTrap } from "./bits";

/** Add a product from a local clone of its GitHub repository. */
export function AddProductDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (productId: string) => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const status = useEngineStatus();
  const live = status.link === "live";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose);

  const add = async () => {
    if (!path.trim() || !name.trim() || !live || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = await sim.addProduct(path.trim(), name);
      onAdded(String(id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dialog-scrim" onClick={onClose} />
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-product-title" tabIndex={-1}>
        <div className="row" style={{ gap: 12, marginBottom: 8 }}>
          <span className="avatar tone-violet" style={{ width: 40, height: 40, borderRadius: 12 }} aria-hidden="true">
            <FolderGit2 size={20} />
          </span>
          <div>
            <h2 className="heading" id="add-product-title">
              Add a product
            </h2>
            <p style={{ color: "var(--text-2)" }}>Point Petrina at a local clone of the product's GitHub repository.</p>
          </div>
        </div>
        <label className="product-field">
          Folder of the local clone
          <input
            autoFocus
            className="field"
            aria-label="Folder of the local clone"
            placeholder="/Users/you/code/my-product"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setName(suggestProductName(event.target.value));
            }}
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
            onChange={(event) => setName(event.target.value)}
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
        <div className="foot" style={{ marginTop: 16 }}>
          <span className="left">Each task gets its own working copy, so your clone stays untouched.</span>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn lead" disabled={!path.trim() || !name.trim() || busy || !live} onClick={() => void add()}>
            {busy ? "Adding…" : "Add product"}
          </button>
        </div>
      </div>
    </>
  );
}
