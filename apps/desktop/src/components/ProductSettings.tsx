import { useEffect, useState } from "react";
import { DELIVERY_LABEL, productHistory, involvesProduct, taskProductIds, type DeliveryMode, type Product, type State } from "@petrina/core";
import { Settings2 } from "lucide-react";
import { ConfirmDialog } from "./bits";
import { EditorPanel, FormSection } from "./EditorPanel";
import { ProductCheckSetup } from "./ProductCheckSetup";
import { sim, useEngineStatus } from "../engine";

/** Product settings leave the repository identity unchanged. */
export function ProductEditor({ product, state, onClose, onRemoved }: { product: Product; state: State; onClose: () => void; onRemoved: () => void }) {
  const [name, setName] = useState(product.name);
  const [delivery, setDelivery] = useState<DeliveryMode>(product.delivery ?? "pull-request");
  const [approveDelivery, setApproveDelivery] = useState(product.approveDelivery ?? true);
  const [shipLowRisk, setShipLowRisk] = useState(product.shipLowRisk ?? false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [checkState, setCheckState] = useState({ busy: false, dirty: false });
  const [setupState, setSetupState] = useState({ busy: false, dirty: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const live = useEngineStatus().link === "live";
  const { unfinished: liveUnfinished } = productHistory(state.tasks, product.id);
  const involved = state.tasks.filter((task) => involvesProduct(task, product.id));
  const archived = state.history?.products.find((entry) => entry.productId === product.id);
  const unfinished = liveUnfinished + (archived?.blocked ?? 0);
  const finished = involved.filter((task) => taskProductIds(task).length === 1 && ["done", "cancelled"].includes(task.state)).length + (archived?.done ?? 0) + (archived?.cancelled ?? 0) - (archived?.shared ?? 0);
  const retained = involved.filter((task) => taskProductIds(task).length > 1).length + (archived?.shared ?? 0);
  const pending = busy || checkState.busy || setupState.busy;
  const dirty = name !== product.name || delivery !== (product.delivery ?? "pull-request") || approveDelivery !== (product.approveDelivery ?? true) || shipLowRisk !== (product.shipLowRisk ?? false) || checkState.dirty || setupState.dirty;
  const close = () => { if (!pending) { if (dirty) setDiscarding(true); else onClose(); } };
  const save = async () => {
    if (!live || pending) return;
    if (checkState.dirty) { setError("Save or cancel your check edits first."); return; }
    if (setupState.dirty) { setError("Save or cancel your local setup edits first."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await sim.updateProduct(product.id, { name, delivery, approveDelivery, shipLowRisk });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!live || pending || unfinished) return;
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

  return <>
    <EditorPanel id={`product-editor-${product.id}`} title={`${product.name} settings`} description="Product details, delivery defaults and local checks." icon={<Settings2 size={22} />} className="product-editor" onClose={close} busy={pending}
      footer={<><button className="btn" disabled={pending} onClick={close}>Cancel</button><span className="spacer" /><button className="btn lead" disabled={!live || pending} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></>}>
      <FormSection title="Product details">
        <label className="form-field"><span className="field-label">Name</span><input autoFocus className="field" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void save(); }} /></label>
      </FormSection>
      <FormSection title="Delivery defaults" description="Choose what happens when new work is ready.">
        <div className="product-delivery-options">
          <div className="opt"><span id={`product-delivery-${product.id}`}>When work is ready</span><div className="segmented" role="radiogroup" aria-labelledby={`product-delivery-${product.id}`}>
            {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map(mode => <button key={mode} role="radio" aria-checked={delivery === mode} className={delivery === mode ? "on" : ""} onClick={() => setDelivery(mode)}>{DELIVERY_LABEL[mode]}</button>)}
          </div></div>
          <div className="toggles">
            <label className="toggle"><input type="checkbox" checked={approveDelivery} onChange={event => setApproveDelivery(event.target.checked)} />Ask me before shipping</label>
            <label className="toggle"><input type="checkbox" checked={approveDelivery && shipLowRisk} disabled={!approveDelivery} onChange={event => setShipLowRisk(event.target.checked)} />Except low-risk work</label>
          </div>
        </div>
      </FormSection>
      <ProductChecks product={product} live={live} onState={setCheckState} />
      <ProductCheckSetup product={product} live={live} onState={setSetupState} />
      <FormSection title="Remove product" description="Remove this product and its task history from Petrina. Your repository and GitHub stay as they are.">
        <div><button className="btn danger" disabled={unfinished > 0 || !live || pending} onClick={() => { setError(undefined); setConfirming(true); }}>Remove product</button></div>
        {unfinished > 0 && <p className="setting-hint">{archived?.blocked ? "Resolve the unfinished shared deliveries before removing this product." : `${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`}</p>}
      </FormSection>
      {!live && <p className="setting-hint" role="status">Waiting for the engine before saving or removing this product.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </EditorPanel>
    {discarding && <ConfirmDialog title="Discard product changes?" confirm="Discard changes" cancel="Keep editing" onCancel={() => setDiscarding(false)} onConfirm={onClose}><p>Your unsaved changes will be lost.</p></ConfirmDialog>}
    {confirming && <ConfirmDialog title={`Remove ${product.name}?`} confirm={busy ? "Removing…" : finished > 0 ? `Remove and delete ${finished} task${finished === 1 ? "" : "s"}` : "Remove product"} busy={pending} onCancel={() => { setConfirming(false); setError(undefined); }} onConfirm={() => void remove()}>
      <p>{finished > 0 ? `This permanently deletes ${finished} finished and cancelled task${finished === 1 ? "" : "s"} from Petrina, including their conversations, timelines, and design and review history. This cannot be undone.` : retained > 0 ? "No shared task history will be deleted." : "This product has no task history."}</p>
      <p>Your repository, its local folder, its branches and GitHub are not touched.</p>
      {retained > 0 && <p>{retained} shared task{retained === 1 ? " stays" : "s stay"} under the remaining products, with historical names and deliveries kept.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </ConfirmDialog>}
  </>;
}

/**
 * The commands that prove this product works. The Check finder works them out from the repository
 * (its CI first); Petrina runs them itself on every task. The coordinator can set them by hand.
 */
function ProductChecks({ product, live, onState }: { product: Product; live: boolean; onState: (state: { busy: boolean; dirty: boolean }) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const checks = product.checks ?? [];
  const savedText = checks.map(check => `${check.name}: ${check.argv.map(part => (/\s/.test(part) ? `"${part}"` : part)).join(" ")}`).join("\n");
  const dirty = editing && text !== savedText;
  useEffect(() => { onState({ busy, dirty }); }, [busy, dirty, onState]);
  const start = () => {
    setText(checks.map((check) => `${check.name}: ${check.argv.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ")}`).join("\n"));
    setError(undefined);
    setEditing(true);
  };
  const run = async (checksOrNull: { name: string; command: string }[] | null) => {
    if (!live || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await sim.setProductChecks(product.id, checksOrNull);
      setEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const parsed = lines.map((line) => {
      const colon = line.indexOf(":");
      return colon > 0 ? { name: line.slice(0, colon).trim(), command: line.slice(colon + 1).trim() } : { name: line.split(/\s+/)[0] ?? line, command: line };
    });
    void run(parsed.filter((check) => check.name && check.command));
  };
  const source = product.checksBy === "coordinator" ? "Set by you." : product.checksBy === "finder" ? "Found by the Check finder from the repository, its CI first. It looks again when the CI or build files change." : "Not found yet: the Check finder works them out at this product's first review.";
  return (
    <FormSection title="Automated checks" description={<>Run before review and the delivery check. {source}</>}>
      {editing ? (
        <>
          <textarea className="field mono" rows={Math.max(3, text.split("\n").length + 1)} value={text} onChange={(event) => setText(event.target.value)} aria-label="Checks, one per line as Name: command" placeholder={"Tests: dotnet test\nBuild: dotnet build --nologo"} />
          <p className="setting-hint">One per line, as Name: command. Commands run from the repository root without a shell, so no pipes or &&.</p>
          <div className="row-actions">
            <button className="btn primary" disabled={!live || busy} onClick={save}>
              Save checks
            </button>
            <button className="btn quiet" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {checks.length > 0 && (
            <ul className="product-check-list">
              {checks.map((check) => (
                <li key={check.name}>
                  <strong>{check.name}</strong>
                  <span className="product-check-command mono">{check.argv.join(" ")}</span>
                  {check.why && <span className="setting-hint">{check.why}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="row-actions">
            <button className="btn" disabled={!live || busy} onClick={start}>
              {checks.length ? "Edit checks" : "Set checks by hand"}
            </button>
            {product.checksBy !== undefined && (
              <button className="btn quiet" disabled={!live || busy} onClick={() => void run(null)}>
                Find again
              </button>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </FormSection>
  );
}
