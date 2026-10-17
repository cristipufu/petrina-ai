import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { DELIVERY_LABEL, productHistory, type DeliveryMode, type Product, type State } from "@petrina/core";
import { sim, useEngineStatus } from "../engine";

/**
 * The Products section of Settings: each product's name and delivery defaults, and its removal.
 * One product is open at a time; the Products page opens one here with its Settings button.
 */
export function ProductSettings({ state, open, onOpen }: { state: State; open: string | undefined; onOpen: (productId: string | undefined) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const products = [...state.products].sort((a, b) => a.name.localeCompare(b.name));
  const editButton = (productId: string) => list.current?.querySelector<HTMLElement>(`[data-product-edit="${CSS.escape(productId)}"]`);

  // Opened from the Products page: that product comes into view.
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-product-id="${CSS.escape(open)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const close = (productId: string) => {
    onOpen(undefined);
    editButton(productId)?.focus();
  };

  return (
    <section className="settings-section" aria-labelledby="settings-products">
      <h2 className="section-title" id="settings-products" ref={heading} tabIndex={-1}>
        Products
      </h2>
      <p className="setting-hint section-hint">Each product's name and what happens when its work is ready. These are the defaults for new tasks; tasks already on the board keep their choices.</p>
      {products.length === 0 ? (
        <div className="empty-state">No products yet. Add one from the Products page.</div>
      ) : (
        <div className="setting-list" ref={list}>
          {products.map((product) => {
            const editing = open === product.id;
            return (
              <div key={product.id} className={`product-setting ${editing ? "open" : ""}`} data-product-id={product.id}>
                <div className="product-setting-row">
                  <span className={`product-cell tone-${product.tone}`}>
                    <i aria-hidden="true" />
                    <span style={{ minWidth: 0 }}>
                      <span className="name">{product.name}</span>
                      <span className="repo">{product.repo}</span>
                    </span>
                  </span>
                  <span className="delivery-summary">
                    {DELIVERY_LABEL[product.delivery ?? "pull-request"]} · {(product.approveDelivery ?? true) ? "asks first" : "ships automatically"}
                  </span>
                  <button
                    className="btn small"
                    data-product-edit={product.id}
                    aria-expanded={editing}
                    aria-controls={`product-editor-${product.id}`}
                    aria-label={`Edit ${product.name}`}
                    onClick={() => onOpen(editing ? undefined : product.id)}
                  >
                    Edit
                  </button>
                </div>
                {editing && (
                  <ProductEditor
                    key={product.id}
                    product={product}
                    state={state}
                    onClose={() => close(product.id)}
                    onRemoved={() => {
                      onOpen(undefined);
                      heading.current?.focus();
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Only display names and defaults change here; the repository's identity never does. */
function ProductEditor({ product, state, onClose, onRemoved }: { product: Product; state: State; onClose: () => void; onRemoved: () => void }) {
  const [name, setName] = useState(product.name);
  const [delivery, setDelivery] = useState<DeliveryMode>(product.delivery ?? "pull-request");
  const [approveDelivery, setApproveDelivery] = useState(product.approveDelivery ?? true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const back = useRef<HTMLButtonElement>(null);
  const live = useEngineStatus().link === "live";
  const { unfinished, finished } = productHistory(state.tasks, product.id);
  const close = () => {
    if (!busy) onClose();
  };
  const cancelRemoval = () => {
    setConfirming(false);
    setError(undefined);
  };
  useEffect(() => {
    if (confirming) back.current?.focus();
  }, [confirming]);

  // Escape discards the edits, or steps back from removing.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (confirming) cancelRemoval();
    else close();
  };

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
    <div className="product-editor" id={`product-editor-${product.id}`} role="group" aria-label={confirming ? `Remove ${product.name}` : `${product.name} settings`} onKeyDown={onKey}>
      {confirming ? (
        <>
          <h3 className="setting-name">Remove {product.name}?</h3>
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
            <input
              autoFocus
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
          </label>
          <div className="options">
            <div className="opt">
              <span id={`product-delivery-${product.id}`}>When work is ready</span>
              <div className="segmented" role="radiogroup" aria-labelledby={`product-delivery-${product.id}`}>
                {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map((mode) => (
                  <button key={mode} role="radio" aria-checked={delivery === mode} className={delivery === mode ? "on" : ""} onClick={() => setDelivery(mode)}>
                    {DELIVERY_LABEL[mode]}
                  </button>
                ))}
              </div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={approveDelivery} onChange={(event) => setApproveDelivery(event.target.checked)} />
              Ask me before shipping
            </label>
          </div>
          <ProductChecks product={product} live={live} />
          <div className="product-removal">
            <button
              className="btn danger"
              disabled={unfinished > 0 || !live || busy}
              onClick={() => {
                setError(undefined);
                setConfirming(true);
              }}
            >
              Remove product
            </button>
            {unfinished > 0 && <p className="setting-hint">{unfinished} task{unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.</p>}
          </div>
        </>
      )}
      {!live && (
        <p className="setting-hint" role="status">
          Waiting for the engine before saving or removing this product.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="foot">
        <button ref={back} className="btn quiet" disabled={busy} onClick={confirming ? cancelRemoval : close}>
          Cancel
        </button>
        {confirming ? (
          <button key="remove" className="btn danger" disabled={!live || busy || unfinished > 0} onClick={() => void remove()}>
            {busy ? "Removing…" : finished > 0 ? `Remove and delete ${finished} task${finished === 1 ? "" : "s"}` : "Remove product"}
          </button>
        ) : (
          <button key="save" className="btn lead" disabled={!live || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The commands that prove this product works. The Check finder works them out from the repository
 * (its CI first); Petrina runs them itself on every task. The coordinator can set them by hand.
 */
function ProductChecks({ product, live }: { product: Product; live: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const checks = product.checks ?? [];
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
    <div className="product-checks">
      <div className="product-checks-title">Checks Petrina runs</div>
      <p className="setting-hint">Petrina runs these itself before every review and right before your delivery check, so a passing check is evidence, never an agent's word. {source}</p>
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
            <ul className="check-list">
              {checks.map((check) => (
                <li key={check.name}>
                  <b>{check.name}</b> <span className="mono quiet-text">{check.argv.join(" ")}</span>
                  {check.why && <span className="quiet-text"> · {check.why}</span>}
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
    </div>
  );
}
