import { reviewStats, type State } from "@petrina/core";
import { profileText, type Lookup } from "../lib";

const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

/** How reviews are going: rounds to pass, what became of findings, and how each reviewer's findings held up. */
export function ReviewsPanel({ state, find }: { state: State; find: Lookup }) {
  const stats = reviewStats(state.tasks);
  const { findings } = stats;
  if (stats.reviewed === 0 && findings.total === 0) return <div className="empty-state">No review has finished yet. Numbers show here once one has.</div>;

  const outcomes = [
    [findings.fixed, "fixed"],
    [findings.notABug, "not a bug"],
    [findings.unverified, "could not verify"],
    [findings.downgraded, "downgraded by the checker"],
    [findings.kept, "kept by the builder, with a reason"],
    [findings.open, "still open"],
  ] as const;

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Passed in the first round</span>
          <span className="kpi-value">{share(stats.passed.first, stats.passed.total)}</span>
          <span className="kpi-note">
            {stats.passed.first} of {stats.passed.total} that passed
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Rounds to pass, on average</span>
          <span className="kpi-value">{stats.meanRounds === undefined ? "–" : stats.meanRounds.toFixed(1)}</span>
          <span className="kpi-note">{stats.passed.later ? `${stats.passed.later} took four or more` : "None took four or more"}</span>
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

      {findings.total > 0 && (
        <p className="kpi-line">
          Of {findings.total} finding{findings.total === 1 ? "" : "s"}:{" "}
          {outcomes
            .filter(([count]) => count > 0)
            .map(([count, what]) => `${count} ${what}`)
            .join(" · ")}
          .
        </p>
      )}

      {stats.profiles.length > 0 && (
        <div className="portfolio-wrap">
          <table className="portfolio narrow">
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
      )}
    </>
  );
}
