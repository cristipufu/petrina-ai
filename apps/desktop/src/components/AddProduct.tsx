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
      <div className="dialog" role="dialog" aria-label="Add a product">
        <div className="row" style={{ gap: 12, marginBottom: 6 }}>
          <span className="avatar tone-violet" style={{ width: 38, height: 38, borderRadius: 12 }}>
            <FolderGit2 size={20} />
          </span>
          <div>
            <div style={{ fontWeight: 680, fontSize: 16 }}>Add a product</div>
            <div style={{ color: "var(--text-3)", fontSize: 12.5 }}>Point Petrina at a local clone of the product's GitHub repository.</div>
          </div>
        </div>
        <input
          autoFocus
          className="field"
          style={{ width: "100%", margin: "12px 0 6px", fontFamily: "var(--mono)", fontSize: 12.5 }}
          placeholder="/Users/you/code/my-product"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
        {error && <div style={{ color: "var(--red)", fontSize: 12.5, margin: "4px 0 8px" }}>{error}</div>}
        <div className="foot" style={{ marginTop: 10 }}>
          <span className="left">Each task gets its own working copy, so your clone stays untouched.</span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!path.trim() || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add product"}
          </button>
        </div>
      </div>
    </>
  );
}
