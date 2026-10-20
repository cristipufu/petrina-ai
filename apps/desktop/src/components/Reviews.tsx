import { combineReviewStats, reviewStats, type ReviewStats, type FindingStats, type State, type VerificationOutcomes, type VerifierStats } from "@petrina/core";
import { profileText, type Lookup } from "../lib";

const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

const OUTCOMES = [
  ["fixed", "Fixed", "Fixed by the builder"],
  ["notABug", "Not a bug", "Dismissed as not a bug"],
  ["unverified", "Could not verify", "The checker could not verify the finding"],
  ["downgraded", "Downgraded", "Downgraded by the checker to a nit or an older issue"],
  ["kept", "Kept", "Kept by the builder, with a reason"],
  ["open", "Still open", "Findings still open"],
] as const satisfies readonly [keyof FindingStats, string, string][];

const outcomeCells = (findings: FindingStats) => OUTCOMES.map(([key]) => <td key={key} className="c">{findings[key]}</td>);
const verificationCells = (entry: VerificationOutcomes) => ["completed", "real", "notABug", "nit", "preExisting", "unfinished"].map((key) => <td key={key} className="c">{entry[key as keyof VerificationOutcomes]}</td>);

/** How reviews are going: rounds to pass, what became of findings, and how each reviewer's findings held up. */
export function ReviewsPanel({ tasks, roles, find, history }: { tasks: State["tasks"]; roles: State["roles"]; find: Lookup; history?: ReviewStats }) {
  const stats = combineReviewStats(reviewStats(tasks), ...(history ? [history] : []));
  const { findings } = stats;
  const roleRows = [...stats.roles, ...roles.filter((role) => role.result === "findings" && !stats.roles.some((entry) => entry.roleId === role.id)).map((role) => ({ roleId: role.id, important: 0, findings: { total: 0, fixed: 0, notABug: 0, unverified: 0, downgraded: 0, kept: 0, open: 0 } }))];
  if (stats.reviewed === 0 && findings.total === 0) return <div className="empty-state">No review has finished yet. Numbers show here once one has.</div>;

  return (
    <div className="review-summary">
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Stayed in round one</span>
          <span className="kpi-value">{share(stats.passed.first, stats.passed.total)}</span>
          <span className="kpi-note">
            {stats.passed.first} of {stats.passed.total} that passed
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Highest round, on average</span>
          <span className="kpi-value">{stats.meanRounds === undefined ? "–" : stats.meanRounds.toFixed(1)}</span>
          <span className="kpi-note">{stats.passed.later ? `${stats.passed.later} reached round four or later` : "None reached round four"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Handed to you unsettled</span>
          <span className="kpi-value">{stats.reviewed - stats.passed.total}</span>
          <span className="kpi-note">Review rounds used up with Important findings open</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Sent back by you</span>
          <span className="kpi-value">{stats.sentBack}</span>
          <span className="kpi-note">Deliveries every reviewer had passed</span>
        </div>
      </div>

      <p className="muted small">Round figures use each passed task’s highest numbered review round across all its review stages. A stage visited twice in round 3 still counts as round 3; these figures do not count total review passes, parallel reviewers or verifier checks.</p>

      {roleRows.length > 0 && <section className="analytics-subsection" aria-labelledby="review-role-findings">
        <h3 id="review-role-findings">Findings by review role</h3>
        <div className="portfolio-wrap">
          <table className="portfolio narrow" aria-label="Findings by review role">
            <thead><tr><th scope="col">Review role</th><th scope="col" className="c">Findings</th><th scope="col" className="c" title="Important when raised">Important</th>{OUTCOMES.map(([key, label, detail]) => <th key={key} scope="col" className="c" title={detail}>{label}</th>)}</tr></thead>
            <tbody>{roleRows.map((entry) => <tr key={entry.roleId}><th scope="row">{find.role(entry.roleId)?.name ?? "Former review role"}</th><td className="c">{entry.findings.total}</td><td className="c">{entry.important}</td>{outcomeCells(entry.findings)}</tr>)}</tbody>
            <tfoot><tr><th scope="row">All reviewers</th><td className="c">{findings.total}</td><td className="c">{stats.roles.reduce((sum, entry) => sum + entry.important, 0)}</td>{outcomeCells(findings)}</tr></tfoot>
          </table>
        </div>
        <p className="muted small review-table-note">Downgraded: a nit or an older issue. Kept: the builder gave a reason to leave it.</p>
      </section>}

      <VerifierResults stats={stats.verifiers} find={find} />

      {stats.profiles.length > 0 && (
        <section className="analytics-subsection" aria-labelledby="review-profile-findings">
        <h3 id="review-profile-findings">Findings by reviewer</h3>
        <div className="portfolio-wrap">
          <table className="portfolio narrow" aria-label="Findings by reviewer">
            <thead>
              <tr>
                <th scope="col">Reviewer</th>
                <th scope="col" className="c">
                  Findings
                </th>
                <th scope="col" className="c">
                  Important
                </th>
                <th scope="col" className="c" title="Fixed, confirmed by another reviewer, or checked as real">
                  Held up
                </th>
                <th scope="col" className="c">
                  Not a bug
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.profiles.map((entry) => (
                <tr key={entry.profileId}>
                  <td>{profileText(find.profile(entry.profileId), find, true)}</td>
                  <td className="c">{entry.raised}</td>
                  <td className="c">{entry.important}</td>
                  <td className="c">{entry.important ? `${entry.heldUp} (${share(entry.heldUp, entry.important)})` : "–"}</td>
                  <td className="c">{entry.notABug}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </section>
      )}
    </div>
  );
}

function VerifierResults({ stats, find }: { stats: VerifierStats; find: Lookup }) {
  const changed = stats.notABug + stats.nit + stats.preExisting;
  if (!stats.completed && !stats.unfinished) return <section className="analytics-subsection"><h3>What verifiers changed</h3><p className="muted small">No verification decisions recorded yet.</p></section>;
  return <>
    <section className="analytics-subsection" aria-labelledby="verifier-impact">
      <h3 id="verifier-impact">What verifiers changed</h3>
      <p className="review-impact"><strong>{changed} of {stats.completed} completed checks ({share(changed, stats.completed)})</strong> removed an Important finding as a blocker.</p>
      <div className="portfolio-wrap"><table className="portfolio narrow" aria-label="Verifier outcomes">
        <thead><tr><th scope="col">Original review role</th><th scope="col" className="c">Checks completed</th><th scope="col" className="c">Confirmed Important</th><th scope="col" className="c">Not a bug</th><th scope="col" className="c">To nit</th><th scope="col" className="c">Pre-existing</th><th scope="col" className="c">No final verdict</th></tr></thead>
        <tbody>{stats.roles.map((entry) => <tr key={entry.roleId}><th scope="row">{find.role(entry.roleId)?.name ?? "Former review role"}</th>{verificationCells(entry)}</tr>)}</tbody>
        <tfoot><tr><th scope="row">All checks</th>{verificationCells(stats)}</tr></tfoot>
      </table></div>
      <p className="muted small review-table-note">Each verification round counts once. A finding checked again after a fix counts again; these totals keep the earlier decisions.</p>
    </section>
    {stats.profiles.length > 0 && <section className="analytics-subsection" aria-labelledby="verifier-votes">
      <h3 id="verifier-votes">Votes by verifier</h3>
      <div className="portfolio-wrap"><table className="portfolio narrow" aria-label="Votes by verifier">
        <thead><tr><th scope="col">Verifier</th><th scope="col" className="c">Votes</th><th scope="col" className="c">Important</th><th scope="col" className="c">Not a bug</th><th scope="col" className="c">To nit</th><th scope="col" className="c">Pre-existing</th><th scope="col" className="c">Agreed with final verdict</th></tr></thead>
        <tbody>{stats.profiles.map((entry) => {
          const profile = find.profile(entry.profileId);
          const label = profile?.toolId === entry.toolId ? profileText(profile, find, true) : `${find.tool(entry.toolId)?.name ?? "Former tool"} · model not recorded`;
          return <tr key={JSON.stringify([entry.profileId, entry.toolId])}><th scope="row">{label}</th><td className="c">{entry.votes}</td><td className="c">{entry.real}</td><td className="c">{entry.notABug}</td><td className="c">{entry.nit}</td><td className="c">{entry.preExisting}</td><td className="c">{entry.decided ? `${entry.matched} of ${entry.decided} (${share(entry.matched, entry.decided)})` : "No final verdict"}</td></tr>;
        })}</tbody>
      </table></div>
      <p className="muted small review-table-note">One vote per actual tool per check. Agreement measures consistency with the final group verdict, not whether it was correct.{stats.unattributedVotes ? ` ${stats.unattributedVotes} older vote records have no proven tool and are left out of this comparison.` : ""}</p>
    </section>}
  </>;
}
