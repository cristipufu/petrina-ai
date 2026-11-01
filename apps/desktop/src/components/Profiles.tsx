import { Select } from "./Select";
import { useEffect, useId, useRef, useState } from "react";
import { Cpu, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  CHECK_NAMES,
  EFFORTS,
  PROVIDER_IDS,
  profileModelName,
  profileReferences,
  type AgentProfile,
  type CheckId,
  type Effort,
  type ProfileChoices,
  type ProfileDraft,
  type State
} from "@petrina/core";
import { failureText, sim, useEngineStatus } from "../engine";
import { EFFORT_LABEL } from "../lib";
import { ConfirmDialog } from "./bits";
import { EditorPanel, FormSection } from "./EditorPanel";
import { ToolIcon } from "./ToolIcon";

const toolName = (state: State, id: string) => state.tools.find(tool => tool.id === id)?.name ?? CHECK_NAMES[id as CheckId] ?? id;
export function Profiles({ state }: { state: State }) {
  const connected = useEngineStatus().link === "live";
  const [editing, setEditing] = useState<AgentProfile | "new">();
  const groups = new Map<string, AgentProfile[]>();
  for (const profile of state.profiles) {
    const key = JSON.stringify([profile.toolId, profile.modelId ?? profile.model]);
    groups.set(key, [...groups.get(key) ?? [], profile]);
  }
  return <>
    <div className="profiles-heading"><div><h2>Profiles</h2><p className="note">Choose which tool, model and effort your agents can use.</p></div><button
      className="btn"
      disabled={!connected}
      onClick={() => setEditing("new")}
    ><Plus size={16} />New profile</button></div>
    <div className="profile-grid">{[...groups].map(([key, profiles]) => {
      const first = profiles[0]!;
      return <section className="profile-card" key={key}>
        <header><ToolIcon toolId={first.toolId} /><div><h3>{profileModelName(first)}</h3><p>{toolName(state, first.toolId)}</p></div></header>
        <ul>{profiles.toSorted((a, b) => EFFORTS.indexOf(b.effort) - EFFORTS.indexOf(a.effort)).map(profile => {
          const references = profileReferences(state, profile.id);
          return <li key={profile.id}><div className="profile-effort"><span
            className="effort-meter"
            aria-hidden="true"
          >{EFFORTS.map((
            _,
            i
          ) => <i
            key={i}
            className={i <= EFFORTS.indexOf(profile.effort) ? "filled" : ""}
          />)}</span><div><strong>{EFFORT_LABEL[profile.effort]}</strong><span>{profile.standby ? "Stand-in only" : references.length ? "In use" : "Available for new work"}</span></div></div><button
            className="btn quiet small icon"
            aria-label={`Edit ${toolName(
            state,
            profile.toolId
          )} ${profileModelName(profile)}, ${EFFORT_LABEL[profile.effort]}`}
            onClick={() => setEditing(profile)}
          ><Pencil size={15} /></button></li>;
        })}</ul>
      </section>;
    })}</div>
    {editing && <ProfileEditor
      key={typeof editing === "string" ? editing : editing.id}
      state={state}
      profile={editing === "new" ? undefined : editing}
      onClose={() => setEditing(undefined)}
    />}
  </>;
}

function ProfileEditor({ state, profile, onClose }: { state: State; profile?: AgentProfile; onClose: () => void }) {
  const initial: ProfileDraft = {
    toolId: profile?.toolId ?? state.tools.find(tool => tool.models.length)?.id ?? state.tools[0]?.id ?? PROVIDER_IDS[0]!,
    modelId: profile?.modelId ?? "",
    effort: profile?.effort ?? "high",
    standby: Boolean(profile?.standby)
  };
  const baseline = useRef(initial);
  const touched = useRef(false);
  const clientId = useRef(crypto.randomUUID());
  const [draft, setDraft] = useState(initial);
  const [choices, setChoices] = useState<ProfileChoices>();
  const [loading, setLoading] = useState(true);
  const [request, setRequest] = useState({ toolId: initial.toolId, modelId: initial.modelId });
  const forceRefresh = useRef(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<"discard" | "remove">();
  const id = useId();
  const connected = useEngineStatus().link === "live";
  const references = profile ? profileReferences(state, profile.id) : [];
  const blocked = references.length ? `Reassign ${references.slice(
    0,
    3
  ).join(", ")}${references.length > 3 ? ` and ${references.length - 3} more` : ""} before changing or removing this profile.` : undefined;
  useEffect(() => {
    let current = true;
    if (!connected) {
      setLoading(false);
      return;
    }
    const refresh = forceRefresh.current;
    forceRefresh.current = false;
    setLoading(true);
    setChoices(undefined);
    setError("");
    void Promise.resolve().then(() => sim.profileChoices({
      toolId: request.toolId,
      ...(request.modelId ? { modelId: request.modelId } : {}),
      refresh
    })).then(result => {
      if (!current) return;
      setChoices(result);
      setDraft(previous => {
        const next = { ...previous, modelId: result.modelId, effort: result.efforts.includes(previous.effort) ? previous.effort : result.efforts[0]! };
        if (!touched.current && !profile) baseline.current = next;
        return next;
      });
    }).catch(failure => { if (current) setError(failureText(failure)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [request, connected]);
  const close = () => { if (!busy) { if (JSON.stringify(draft) !== JSON.stringify(baseline.current)) setAsking("discard");
  else onClose(); } };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await sim.saveProfile(
      draft,
      clientId.current,
      profile?.id
    );
      onClose();
    } catch (failure) { setError(failureText(failure)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setAsking(undefined);
    setBusy(true);
    setError("");
    try {
      await sim.removeProfile(profile!.id);
      onClose();
    } catch (failure) { setError(failureText(failure)); } finally { setBusy(false); }
  };
  return <><EditorPanel
    title={profile ? "Edit profile" : "New profile"}
    description="Models and effort levels come from the installed tool."
    icon={<Cpu size={22} />}
    onClose={close}
    busy={busy}
    bodyClassName="role-form"
    footer={<div className="profile-editor-actions"><button
    className="btn"
    disabled={busy}
    onClick={close}
  >Cancel</button>{profile && <button
    className="btn quiet danger"
    disabled={busy || !connected || Boolean(blocked)}
    onClick={() => setAsking("remove")}
  ><Trash2 size={16} />Remove profile</button>}<span /><button
    className="btn lead"
    disabled={busy || !connected || loading || Boolean(blocked) || !choices || !choices.efforts.includes(draft.effort)}
    onClick={() => void save()}
  >{busy ? "Saving…" : "Save profile"}</button></div>}
  >
    {blocked && <p className="callout" role="status">{blocked}</p>}
    <FormSection title="Agent" description="Choose the installed tool, model and reasoning effort.">
    <label
      className="form-field"
      htmlFor={`${id}-tool`}
    ><span className="field-label">Tool</span><Select
      id={`${id}-tool`}
      aria-label="Tool"
      className="select"
      value={draft.toolId}
      onChange={event => {
      touched.current = true;
      forceRefresh.current = false;
      setRequest({
      toolId: event.target.value,
      modelId: ""
    });
      setDraft(previous => ({
      ...previous,
      toolId: event.target.value,
      modelId: ""
    }));
    }}
    >{[...new Set([
      ...state.tools.filter(tool => tool.models.length).map(tool => tool.id),
      ...state.profiles.map(profile => profile.toolId)
    ])].map(toolId => <option
      key={toolId}
      value={toolId}
    >{toolName(
      state,
      toolId
    )}</option>)}</Select></label>
    <label
      className="form-field"
      htmlFor={`${id}-model`}
    ><span className="field-label">Model</span><Select
      id={`${id}-model`}
      aria-label="Model"
      className="select"
      disabled={loading || !choices}
      value={draft.modelId}
      onChange={event => {
      touched.current = true;
      forceRefresh.current = false;
      setRequest({
      toolId: draft.toolId,
      modelId: event.target.value
    });
      setDraft(previous => ({
      ...previous,
      modelId: event.target.value
    }));
    }}
    >{!choices && <option value={draft.modelId}>{loading ? "Reading supported models…" : "Choices unavailable"}</option>}{choices?.models.map(model => <option
      key={model.id}
      value={model.id}
    >{profileModelName({
      toolId: draft.toolId,
      modelId: model.id,
      model: model.name
    })}</option>)}</Select></label>
    <label
      className="form-field"
      htmlFor={`${id}-effort`}
    ><span className="field-label">Effort</span><Select
      id={`${id}-effort`}
      aria-label="Effort"
      className="select"
      disabled={loading || !choices}
      value={draft.effort}
      onChange={event => {
      touched.current = true;
      setDraft(previous => ({
      ...previous,
      effort: event.target.value as Effort
    }));
    }}
    >{choices?.efforts.map(effort => <option
      key={effort}
      value={effort}
    >{EFFORT_LABEL[effort]}</option>)}</Select></label>
    <button
      className="btn quiet small"
      disabled={loading || !connected}
      onClick={() => {
      forceRefresh.current = true;
      setRequest({
      toolId: draft.toolId,
      modelId: draft.modelId
    });
    }}
    ><RefreshCw size={14} />{loading ? "Reading choices…" : "Refresh choices"}</button>
    {error && <p className="error" role="alert">{error}</p>}
    {!connected && <p className="note">Waiting for the engine.</p>}
    </FormSection>
    <FormSection title="Availability">
    <label className="profile-availability"><input
      type="checkbox"
      checked={!draft.standby}
      onChange={event => {
      touched.current = true;
      setDraft(previous => ({
      ...previous,
      standby: !event.target.checked
    }));
    }}
    /><span><strong>Offer to the planner</strong><span>When off, this profile is available only as a stand-in.</span></span></label>
    </FormSection>
  </EditorPanel>
  {asking === "discard" && <ConfirmDialog
    title="Discard profile changes?"
    confirm="Discard changes"
    cancel="Keep editing"
    onCancel={() => setAsking(undefined)}
    onConfirm={onClose}
  ><p>Your unsaved choices will be lost.</p></ConfirmDialog>}
  {asking === "remove" && <ConfirmDialog
    title="Remove this profile?"
    confirm="Remove profile"
    onCancel={() => setAsking(undefined)}
    onConfirm={() => void remove()}
  ><p>It will no longer be offered for new work. Finished tasks keep their recorded profile.</p></ConfirmDialog>}
  </>;
}
