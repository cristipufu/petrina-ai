import { useEffect, useRef, useState } from "react";
import { DELIVERY_LABEL, productHistory, type DeliveryMode, type Product, type State } from "@petrina/core";
import { sim, useEngineStatus } from "../engine";
import { useFocusTrap } from "./bits";

/** Only display names and defaults change here; the repository's identity never does. */
export function ProductSettingsDialog({ product, state, onClose, onRemoved }: { product: Product; state: State; onClose: () => void; onRemoved: () => void }) {
  const [name, setName] = useState(product.name);
  const [delivery, setDelivery] = useState<DeliveryMode>(product.delivery ?? "pull-request");
  const [approveDelivery, setApproveDelivery] = useState(product.approveDelivery ?? true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const live = useEngineStatus().link === "live";
  const { unfinished, finished } = productHistory(state.tasks, product.id);
  const close = () => { if (!busy) onClose(); };
  useFocusTrap(box, close);
  useEffect(() => { if (confirming) back.current?.focus(); }, [confirming]);

  const save = async () => {
    if (!live || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await sim.updateProduct(product.id, { name, delivery, approveDelivery });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!live || busy || unfinished) return;
    setBusy(true);
    setError(undefined);
    try {
      await sim.removeProduct(product.id);
      onRemoved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dialog-scrim" onClick={close} />
      <div ref={box} className="dialog product-settings" role="dialog" aria-modal="true" aria-labelledby="product-settings-title" tabIndex={-1}>
        <h2 className="heading" id="product-settings-title">{confirming ? `Remove ${product.name}?` : `${product.name} settings`}</h2>
        <p className="muted product-repo">{product.repo}</p>
        {confirming ? (
          <>
            <p className="removal-copy">
              {finished > 0
                ? `This permanently deletes ${finished} finished and cancelled task${finished === 1 ? "" : "s"} from Petrina, including their conversations, timelines, and design and review history. This cannot be undone.`
                : "This product has no task history."}
            </p>
            <p>Your repository, its local folder, its branches and GitHub are not touched.</p>
            {unfinished > 0 && <p className="error-text">{unfinished} task{unfinished === 1 ? " must" : "s must"} finish or be cancelled first.</p>}
          </>
        ) : (
          <>
            <label className="product-field">
              Name
              <input autoFocus className="field" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); }} />
            </label>
            <div className="options">
              <div className="opt">
                <span id="product-delivery">When work is ready</span>
                <div className="segmented" role="radiogroup" aria-labelledby="product-delivery">
                  {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map((mode) => (
                    <button key={mode} role="radio" aria-checked={delivery === mode} className={delivery === mode ? "on" : ""} onClick={() => setDelivery(mode)}>{DELIVERY_LABEL[mode]}</button>
                  ))}
                </div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={approveDelivery} onChange={(event) => setApproveDelivery(event.target.checked)} />
                Ask me before shipping
              </label>
            </div>
            <p className="muted">These are the defaults for new tasks. Tasks already on the board keep their choices.</p>
            <div className="product-removal">
              <button className="btn danger" disabled={unfinished > 0 || !live || busy} onClick={() => { setError(undefined); setConfirming(true); }}>Remove product</button>
              {unfinished > 0 && <p className="muted">{unfinished} task{unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.</p>}
            </div>
          </>
        )}
        {!live && <p className="muted" role="status">Waiting for the engine before saving or removing this product.</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="foot">
          <span className="left" />
          <button ref={back} className="btn quiet" disabled={busy} onClick={confirming ? () => { setConfirming(false); setError(undefined); } : close}>Cancel</button>
          {confirming
            ? <button className="btn danger" disabled={!live || busy || unfinished > 0} onClick={() => void remove()}>{busy ? "Removing…" : finished > 0 ? `Remove and delete ${finished} task${finished === 1 ? "" : "s"}` : "Remove product"}</button>
            : <button className="btn lead" disabled={!live || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>}
        </div>
      </div>
    </>
  );
}
