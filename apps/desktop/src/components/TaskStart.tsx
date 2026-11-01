import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import {
  DELIVERY_MODE_CATALOG,
  DELIVERY_SELECT_MODES,
  deliveryLabel,
  deliverySelectLabel,
  profileModelName,
  sourceLabel,
  workSummary,
  type StartFrom,
  type State,
  type Task,
  type WorkChoice,
} from "@petrina/core";
import { sim } from "../engine";

export function StartFromFields({ value, onChange, product }: { value: StartFrom; onChange: (value: StartFrom) => void; product?: string }) {
  return <div className="start-fields">
    <label>Start from
      <Select
        className="select"
        aria-label={product ? `Start from for ${product}` : "Start from"}
        value={value.kind}
        onChange={(event) => onChange(event.target.value === "branch" ? {
        kind: "branch",
        name: ""
      } : event.target.value === "pull-request" ? {
        kind: "pull-request",
        value: ""
      } : { kind: "default" })}
      >
        <option value="default">Default branch</option><option value="branch">Branch</option><option value="pull-request">Pull request</option>
      </Select>
    </label>
    {value.kind !== "default" && <label>{value.kind === "branch" ? "Exact branch name" : "Pull request number or link"}
      <input
        className="select"
        aria-label={`${value.kind === "branch" ? "Exact branch name" : "Pull request number or link"}${product ? ` for ${product}` : ""}`}
        value={value.kind === "branch" ? value.name : value.value}
        placeholder={value.kind === "branch" ? "release-2.x" : "#123 or a GitHub link"}
        onChange={(event) => onChange(value.kind === "branch" ? {
        kind: "branch",
        name: event.target.value
      } : {
        kind: "pull-request",
        value: event.target.value
      })}
      />
    </label>}
  </div>;
}

export function TaskStart({ task, state }: { task: Task; state: State }) {
  return task.workRows ? <ManyTaskStart task={task} state={state} /> : <SingleTaskStart task={task} state={state} />;
}

function SingleTaskStart({ task, state }: { task: Task; state: State }) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<WorkChoice>(task.workProposal?.[0] ?? task.workChoice ?? {
    productId: task.productId,
    startFrom: { kind: "default" },
    delivery: task.delivery
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const source = task.proposedSource ?? task.source;
  const editable = !task.worktree && state.inbox.some((item) => item.taskId === task.id && item.kind === "plan");
  return <section className="sheet-section reading task-start">
    <h2>Works on</h2>
    {source && <><p className="prose">{source.product.name} ({sourceLabel(source)})</p><p className="prose">{workSummary(source).split("\n").slice(1).join("\n")}</p></>}
    {task.workError && <p className="note bad" role="alert">{task.workError}</p>}
    {task.workProposal && task.workProposal.length > 1 && <p className="note">Proposed products: {task.workProposal.map((entry) => state.products.find((product) => product.id === entry.productId)?.name ?? `${entry.productId} (Needs adding)`).join(", ")}</p>}
    {task.proposedSource && <p className="note">The planner proposed a change. Your earlier choices stay in place until you approve this plan.</p>}
    {editable && !editing && <button
      className="btn quiet small"
      onClick={() => {
      setChoice(task.workProposal?.[0] ?? task.workChoice ?? {
      productId: task.productId,
      startFrom: { kind: "default" },
      delivery: task.delivery
    });
      setError("");
      setEditing(true);
    }}
    >Change product or starting point</button>}
    {editable && editing && <div className="stack">
      <label>Product<Select
        className="select"
        aria-label="Works on product"
        value={choice.productId}
        onChange={(event) => setChoice({
        ...choice,
        productId: event.target.value
      })}
      >
        {!state.products.some((product) => product.id === choice.productId) && <option value={choice.productId}>{choice.productId || "Choose a product"} — Needs adding</option>}
        {state.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </Select></label>
      <p className="note">Add an unregistered product through Products, then choose it here.</p>
      <StartFromFields value={choice.startFrom} onChange={(startFrom) => setChoice({ ...choice, startFrom })} />
      <label>When it’s ready<Select
        className="select"
        aria-label="Delivery destination"
        value={choice.delivery}
        onChange={(event) => setChoice({
        ...choice,
        delivery: event.target.value as WorkChoice["delivery"]
      })}
      >
        {DELIVERY_SELECT_MODES.map((mode) => <option key={mode} value={mode}>{deliverySelectLabel(mode, choice.startFrom.kind, { definitePr: true })}</option>)}
      </Select></label>
      {error && <p role="alert" className="note bad">{error}</p>}
      <button
        className="btn"
        disabled={saving || task.workValidating}
        onClick={async () => {
        setSaving(true);
        setError("");
        try {
        await sim.setTaskStart(
        task.id,
        choice
      );
        setEditing(false);
      } catch (error) { setError(String(error)); } finally { setSaving(false); }
      }}
      >Apply choices</button>
    </div>}
    {!source && !task.workError && <p className="note">{deliveryLabel(task)}. The planner will confirm the starting point.</p>}
  </section>;
}

function ManyTaskStart({ task, state }: { task: Task; state: State }) {
  const [editing, setEditing] = useState<string>();
  const [choice, setChoice] = useState<WorkChoice>();
  const [adding, setAdding] = useState<string>();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { if (!editing && !adding) opener.current?.focus(); }, [editing, adding]);
  const editable = !task.repositories?.some((work) => work.completedStages.length) && state.inbox.some((item) => item.taskId === task.id && [
    "plan",
    "stuck"
  ].includes(item.kind));
  const apply = async (action: () => unknown, close: () => void) => {
    setError("");
    setSaving(true);
    try {
      await action();
      close();
    } catch (failure) { setError(String(failure)); } finally { setSaving(false); }
  };
  return <section className="sheet-section reading task-start">
    <h2>Works on</h2>
    <div aria-live="polite">{task.workRows!.map((row, index) => {
      const product = row.source?.product;
      const label = product?.name ?? row.choice.repo ?? row.choice.productId;
      const key = row.choice.productId;
      const work = task.repositories?.find((entry) => entry.productId === product?.id);
      return <div className="repository-row" key={`${product?.repo ?? row.choice.repo ?? key}-${index}`}>
        <h3>{label}</h3><p className="note">{product?.repo ?? row.choice.repo}</p>
        {row.change && <p className="note">{row.change === "omitted" ? "Left out by planner · Your earlier choice is retained" : row.change === "added" ? "Added by planner" : "Starting point or delivery changed"}</p>}
        {row.choice.reason && <p className="prose">{row.choice.reason}</p>}
        {row.previous && <p className="note">Earlier choice: {row.previous.startFrom.kind === "branch" ? row.previous.startFrom.name : row.previous.startFrom.kind === "pull-request" ? `PR ${row.previous.startFrom.value}` : "Default branch"} · {DELIVERY_MODE_CATALOG[row.previous.delivery].previousLabel}</p>}
        {row.source && <p className="prose">{workSummary(row.source).split("\n").slice(1).join("\n")} · {sourceLabel(row.source)}</p>}
        {row.error && <p className="note bad">{row.error}</p>}
        {row.addition && <p className="note">{row.addition.ready ? "Added" : "Will be added"} · {row.addition.path}</p>}
        {work?.preparation && <p className="note">{work.preparation === "ready" ? "Working copy ready" : "Preparation waiting"}</p>}
        {editable && <div className="row wrap">
          <button
            className="btn quiet small"
            aria-label={`Change ${label}`}
            onClick={(event) => {
            opener.current = event.currentTarget;
            setChoice(row.choice);
            setEditing(key);
            setAdding(undefined);
            setError("");
          }}
          >Change</button>
          {!state.products.some((entry) => entry.id === product?.id) && <button
            className="btn quiet small"
            aria-label={`Add product ${label}`}
            onClick={(event) => {
            opener.current = event.currentTarget;
            setAdding(key);
            setChoice(row.choice);
            setEditing(undefined);
            setName(row.addition?.name ?? label);
            setFolder(row.addition?.path ?? "");
            setError("");
          }}
          >{row.addition ? "Change folder" : "Add product…"}</button>}
          <button
            className="btn quiet small"
            aria-label={`Leave out ${label}`}
            onClick={() => void apply(
            () => sim.setTaskProducts(
            task.id,
            task.workRows!.filter((
            _,
            position
          ) => position !== index).map((entry) => entry.choice)
          ),
            () => {}
          )}
          >Leave out</button>
        </div>}
        {editing === key && choice && <fieldset className="stack"><legend>Change {label}</legend>
          <StartFromFields product={label} value={choice.startFrom} onChange={(startFrom) => setChoice({ ...choice, startFrom })} />
          <label>When ready for {label}<Select
            className="select"
            value={choice.delivery}
            onChange={(event) => setChoice({
            ...choice,
            delivery: event.target.value as WorkChoice["delivery"]
          })}
          >{DELIVERY_SELECT_MODES.map((mode) => <option key={mode} value={mode}>{deliverySelectLabel(mode, choice.startFrom.kind)}</option>)}</Select></label>
          <label>Builder for {label}<Select
            className="select"
            value={choice.builderProfileId ?? task.plan?.products?.find((owner) => owner.productId === key)?.builderProfileId ?? task.plan?.stages.find((stage) => state.roles.find(role => role.id === stage.roleId)?.result === "build")?.profileIds[0]}
            onChange={(event) => setChoice({
            ...choice,
            builderProfileId: event.target.value
          })}
          >{state.profiles.map((profile) => <option
            key={profile.id}
            value={profile.id}
          >{profileModelName(profile)} · {profile.effort}</option>)}</Select></label>
          <label className="toggle"><input
            type="checkbox"
            checked={choice.lead ?? task.leadProductId === key}
            onChange={(event) => setChoice({
            ...choice,
            lead: event.target.checked
          })}
          />Lead shared repairs for {label}</label>
          <button
            className="btn"
            disabled={saving || task.workValidating}
            onClick={() => void apply(
            () => sim.setTaskStart(
            task.id,
            choice
          ),
            () => setEditing(undefined)
          )}
          >Apply choices for {label}</button>
          <button className="btn quiet" onClick={() => setEditing(undefined)}>Cancel editing {label}</button>
        </fieldset>}
        {adding === key && product && <fieldset className="stack"><legend>Add {label}</legend>
          <p className="note">Petrina will clone this repository into this permanent folder after you approve the plan. The task receives a separate working copy.</p>
          <label>Product name<input className="select" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Permanent folder<input className="select" value={folder} onChange={(event) => setFolder(event.target.value)} /></label>
          {choice && <label>When ready for {label}<Select
            className="select"
            value={choice.delivery}
            onChange={(event) => setChoice({
            ...choice,
            delivery: event.target.value as WorkChoice["delivery"]
          })}
          >{DELIVERY_SELECT_MODES.map((mode) => <option key={mode} value={mode}>{deliverySelectLabel(mode, choice.startFrom.kind)}</option>)}</Select></label>}
          <button
            className="btn"
            disabled={saving || task.workValidating || !folder.trim() || !name.trim()}
            onClick={() => void apply(
            async () => {
            if (choice && choice.delivery !== row.choice.delivery) await sim.setTaskStart(
            task.id,
            choice
          );
            await sim.setTaskAddition(
            task.id,
            product.repo,
            name,
            folder
          );
          },
            () => setAdding(undefined)
          )}
          >Confirm folder for {label}</button>
          <button className="btn quiet" onClick={() => setAdding(undefined)}>Cancel adding {label}</button>
        </fieldset>}
      </div>;
    })}</div>
    {editable && <label>Add another product<Select
      className="select"
      value=""
      aria-label="Add another product to this plan"
      disabled={saving || task.workValidating}
      onChange={(event) => {
      const product = state.products.find((entry) => entry.id === event.target.value);
      if (product) void apply(
      () => sim.setTaskProducts(
      task.id,
      [
      ...task.workRows!.map((row) => row.choice),
      {
      productId: product.id,
      startFrom: { kind: "default" },
      delivery: product.delivery ?? "pull-request"
    }
    ]
    ),
      () => {}
    );
    }}
    ><option value="">Choose a product</option>{state.products.filter((product) => !task.workRows!.some((row) => row.source?.product.repo.toLowerCase() === product.repo.toLowerCase())).map((product) => <option
      key={product.id}
      value={product.id}
    >{product.name}</option>)}</Select></label>}
    {error && <p role="alert" className="note bad">{error}</p>}
    {task.approvalExplanation && <p className="note">{task.approvalExplanation}</p>}
    {editable && <label className="toggle"><input
      type="checkbox"
      checked={task.approveDelivery}
      onChange={(event) => void sim.setTaskApproval(
      task.id,
      event.target.checked
    )}
    />Ask me before shipping</label>}
  </section>;
}
