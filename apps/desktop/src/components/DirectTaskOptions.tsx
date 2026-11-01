import { directCapableRoles, type Role, type State } from "@petrina/core";
import { lookup, profileText } from "../lib";
import { Select } from "./Select";

export interface DirectTaskOptionsProps {
  readonly state: State;
  readonly directMode: boolean;
  readonly roleId: string;
  readonly profileId: string;
  readonly disabled?: boolean;
  readonly onDirectMode: (direct: boolean) => void;
  readonly onRoleId: (roleId: string) => void;
  readonly onProfileId: (profileId: string) => void;
}

export function DirectTaskOptions({
  state,
  directMode,
  roleId,
  profileId,
  disabled = false,
  onDirectMode,
  onRoleId,
  onProfileId,
}: DirectTaskOptionsProps) {
  const roles = directCapableRoles(state.roles);
  const workflowRoles = roles.filter((role) => role.category !== "maintenance");
  const maintenanceRoles = roles.filter((role) => role.category === "maintenance");
  const find = lookup(state);
  const selectedRole: Role | undefined = roles.find((entry) => entry.id === roleId);
  const renderRoleOption = (role: Role) => (
    <option key={role.id} value={role.id}>
      {role.name} — {role.canEdit ? "Can change files" : "Read-only"}
    </option>
  );
  return (
    <>
      <div className="opt">
        <span id="new-execution-mode">How to run</span>
        <div className="segmented" role="radiogroup" aria-labelledby="new-execution-mode">
          <button
            type="button"
            role="radio"
            aria-checked={!directMode}
            className={!directMode ? "on" : ""}
            disabled={disabled}
            onClick={() => onDirectMode(false)}
          >
            Planned workflow
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={directMode}
            className={directMode ? "on" : ""}
            disabled={disabled}
            onClick={() => onDirectMode(true)}
          >
            Single agent
          </button>
        </div>
      </div>
      {directMode && (
        <>
          <label className="form-field">
            <span className="field-label">Role</span>
            <Select
              className="select"
              aria-label="Role"
              value={roleId}
              disabled={disabled}
              onChange={(event) => onRoleId(event.target.value)}
            >
              {!roles.some((entry) => entry.id === roleId) && <option value={roleId}>Choose an available role</option>}
              {workflowRoles.length > 0 && maintenanceRoles.length > 0 ? (
                <>
                  <optgroup label="Workflow">{workflowRoles.map(renderRoleOption)}</optgroup>
                  <optgroup label="Maintenance">{maintenanceRoles.map(renderRoleOption)}</optgroup>
                </>
              ) : (
                roles.map(renderRoleOption)
              )}
            </Select>
          </label>
          <label className="form-field">
            <span className="field-label">Agent profile</span>
            <Select
              className="select"
              aria-label="Agent profile"
              value={profileId}
              disabled={disabled}
              onChange={(event) => onProfileId(event.target.value)}
            >
              {!state.profiles.some((entry) => entry.id === profileId) && (
                <option value={profileId}>Choose an available agent profile</option>
              )}
              {state.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profileText(profile, find, true)}
                </option>
              ))}
            </Select>
          </label>
          <p className="note">
            {selectedRole?.canEdit
              ? "Runs this agent directly on the selected product without planning or reviewers. If it changes files, Petrina runs checks and delivers."
              : "Runs this agent directly on the selected product without planning, review or delivery. Finished reports stay in History."}
          </p>
        </>
      )}
    </>
  );
}
