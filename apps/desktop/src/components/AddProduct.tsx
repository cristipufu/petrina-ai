import { useEffect, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { sim } from "../engine";

/** Add a product from a local clone of its GitHub repository. */
export function AddProductDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (productId: string) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = await sim.addProduct(path.trim());
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
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-product-title">
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
        <input
          autoFocus
          className="field"
          aria-label="Folder of the local clone"
          style={{ width: "100%", margin: "16px 0 8px" }}
          placeholder="/Users/you/code/my-product"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
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
          <button className="btn lead" disabled={!path.trim() || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add product"}
          </button>
        </div>
      </div>
    </>
  );
}
