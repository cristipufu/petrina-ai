import { useState } from "react";
import { desktop, mode } from "../engine";
import { setSingleKeys, useSingleKeys } from "../keyboard";
import { BrowserNotices, platform, shell, useBrowserPermission, type BrowserPermission, type Platform } from "../notify/channels";
import { sendTest, setNotificationsOn, useNotifySettings } from "../notify/settings";
import { turnOnInBrowser } from "../notify/useNotices";
import type { Theme } from "../theme";
import {
  checkForUpdates,
  installUpdate,
  restartToUpdate,
  setAutoCheck,
  updatesSupported,
  useAutoCheck,
  useUpdate,
} from "../updates";
import { ThemeChoices } from "./ThemeMenu";

/** macOS shows no banner for the app in front, so the Mac test waits for the person to switch away. */
const MAC_TEST_DELAY_MS = 5000;

/** Where a person allows Petrina's notifications in their system's settings. */
const SYSTEM_SETTINGS: Record<Platform, string> = {
  mac: "System Settings, then Notifications, then Petrina",
  windows: "Settings, then System, then Notifications",
  linux: "your desktop's notification settings",
};

/**
 * Honest about what Petrina knows: a browser says whether it allows notifications; the desktop
 * app cannot read the system's setting, so it says so and points to the test.
 */
function permissionLine(permission: BrowserPermission): { text: string; tone: "" | "ok" | "warn" } {
  if (desktop) {
    return {
      text: `Petrina can't check whether your system allows its notifications. Send a test to find out. If nothing shows up, allow Petrina in ${SYSTEM_SETTINGS[platform()]}.`,
      tone: ""
    };
  }
  switch (permission) {
    case "granted":
      return { text: "Your browser allows notifications from Petrina.", tone: "ok" };
    case "denied":
      return {
        text: "Your browser blocks notifications from Petrina. To allow them, open this site's settings from the icon at the left of the address bar, set Notifications to Allow, and come back to this page.",
        tone: "warn",
      };
    case "default":
      return { text: "Your browser hasn't been asked yet. Turning notifications on asks it.", tone: "" };
    default:
      return { text: "This browser can't show notifications. The tab's title still shows how many things wait on you.", tone: "warn" };
  }
}

/** A switch: a button that is on or off, named by the text next to it. */
function Switch({ on, onToggle, labelledBy, describedBy, disabled = false }: {
  on: boolean;
  onToggle: () => void;
  labelledBy: string;
  describedBy: string;
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  );
}

/**
 * Settings for the whole app, one page. Each part of Petrina adds its own section here.
 * Notifications: one switch, an honest line about permission, and a test. Keyboard: the
 * single-key shortcuts. Product settings live on the Products page.
 */
export function SettingsPage({ onShortcuts, theme, onTheme }: { onShortcuts: () => void; theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>For the whole app. Notifications are kept {desktop ? "on this computer, for the desktop app" : "in this browser, for this site"}.</p>
        </div>
      </div>
      <section className="settings-section" aria-labelledby="settings-appearance">
        <h2 className="section-title" id="settings-appearance">Appearance</h2>
        <p className="section-hint">Light and dark looks for the whole app. The same choice is in the top bar.</p>
        <ThemeChoices theme={theme} onTheme={onTheme} framed label="Appearance" idPrefix="theme-settings" />
      </section>
      <NotificationSettings />
      <UpdateSettings />
      <KeyboardSettings onShortcuts={onShortcuts} />
    </div>
  );
}

function UpdateSettings() {
  const supported = updatesSupported();
  const autoCheck = useAutoCheck();
  const update = useUpdate();
  const [notice, setNotice] = useState<string>();

  if (!supported) {
    return (
      <section className="settings-section" aria-labelledby="settings-updates">
        <h2 className="section-title" id="settings-updates">
          Updates
        </h2>
        <p className="permission-line">
          Signed app updates run inside the Petrina desktop app. This browser tab loads Petrina from your running local engine.
        </p>
      </section>
    );
  }

  const statusLine =
    update.status === "available"
      ? `Petrina ${update.info.version} is available (you have ${update.info.current}).${update.info.notes ? ` ${update.info.notes}` : ""}`
      : update.status === "downloading"
        ? update.progress == null
          ? `Downloading Petrina ${update.info.version}…`
          : `Downloading Petrina ${update.info.version}… ${Math.round(update.progress * 100)}%`
        : update.status === "ready"
          ? `Petrina ${update.info.version} is installed. Restart whenever you are ready to switch.`
          : update.status === "failed"
            ? `Couldn't install Petrina ${update.info.version}: ${update.error}`
            : notice;

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h2 className="section-title" id="settings-updates">
        Updates
      </h2>
      <div className="setting">
        <div className="setting-text">
          <div className="setting-name" id="updates-auto-name">
            Check for updates once a day
          </div>
          <p className="setting-hint" id="updates-auto-hint">
            When a newer signed release is published, a quiet Update button appears at the bottom of the left rail. Petrina downloads it only when you click and restarts only when you choose.
          </p>
        </div>
        <Switch
          on={autoCheck}
          onToggle={() => setAutoCheck(!autoCheck)}
          labelledBy="updates-auto-name"
          describedBy="updates-auto-hint"
        />
      </div>
      <div className="setting-actions">
        {(update.status === "idle" || update.status === "checking") && (
          <button
            className="btn"
            disabled={update.status === "checking"}
            onClick={() => {
              setNotice(undefined);
              void checkForUpdates(true, (title, detail) => setNotice(detail ? `${title}. ${detail}` : title));
            }}
          >
            {update.status === "checking" ? "Checking for updates…" : "Check for updates"}
          </button>
        )}
        {(update.status === "available" || update.status === "failed") && (
          <button className="btn" onClick={() => void installUpdate()}>
            {update.status === "failed" ? `Retry update to ${update.info.version}` : `Update to Petrina ${update.info.version}`}
          </button>
        )}
        {update.status === "downloading" && (
          <button className="btn" disabled>
            {update.progress == null ? "Downloading update…" : `Downloading… ${Math.round(update.progress * 100)}%`}
          </button>
        )}
        {update.status === "ready" && (
          <button className="btn" onClick={() => void restartToUpdate()}>
            Restart to update
          </button>
        )}
        {statusLine && (
          <span className="setting-result" role="status">
            {statusLine}
          </span>
        )}
      </div>
    </section>
  );
}

function NotificationSettings() {
  const settings = useNotifySettings();
  const permission = useBrowserPermission();
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  // A Mac test waiting to go out. The switch stays usable meanwhile: switching off stops it.
  const [testing, setTesting] = useState(false);
  // In a browser the switch only shows on while the browser allows them.
  const on = settings.on && (desktop || permission === "granted");
  const line = permissionLine(permission);
  const unsupported = !desktop && permission === "unsupported";

  const toggle = async () => {
    setResult(undefined);
    if (on) return setNotificationsOn(false);
    if (desktop) return setNotificationsOn(true);
    setBusy(true);
    const answer = await turnOnInBrowser();
    setBusy(false);
    if (answer === "denied") setResult("Your browser blocked them, so they stay off.");
    else if (answer !== "granted") setResult("Your browser didn't allow them, so they stay off.");
  };

  const test = async () => {
    setResult(undefined);
    if (desktop) {
      const mac = platform() === "mac";
      if (mac) setResult("Sending in 5 seconds. macOS only shows a notification while another app is in front, so switch to one now.");
      setTesting(true);
      try {
        const sent = await sendTest(() => shell.test(), mac ? MAC_TEST_DELAY_MS : 0);
        setResult(sent === "off" ? "Notifications are off, so the test wasn't sent." : `Sent. If nothing showed up${mac ? " (look in Notification Center too)" : ""}, allow Petrina in ${SYSTEM_SETTINGS[platform()]}.`);
      } catch (error) {
        setResult(typeof error === "string" ? error : "Petrina couldn't send it.");
      } finally {
        setTesting(false);
      }
      return;
    }
    setResult(new BrowserNotices(() => undefined).test() ? "Sent. It shows up the way your browser and system show notifications." : "Your browser didn't show it.");
  };

  return (
    <section className="settings-section" aria-labelledby="settings-notifications">
      <h2 className="section-title" id="settings-notifications">
        Notifications
      </h2>
      <div className="setting">
        <div className="setting-text">
          <div className="setting-name" id="notify-name">
            Notify me when the squad needs me
          </div>
          <p className="setting-hint" id="notify-hint">
            When an agent asks a question, needs your permission or gets stuck, or a task reaches a checkpoint, while Petrina is in the background. At most one every ten seconds; clicking one opens that item in the inbox. While Petrina is in front, a small message shows instead. The {desktop ? "Dock or taskbar icon" : "tab's title"} shows how many things wait on you either way.
          </p>
        </div>
        <Switch on={on} onToggle={() => void toggle()} labelledBy="notify-name" describedBy="notify-hint notify-permission" disabled={busy || unsupported} />
      </div>
      <p className={`permission-line ${line.tone}`} id="notify-permission">
        {line.text}
      </p>
      {mode === "demo" && <p className="setting-hint">The demo's simulated squad never sends notifications or sets the icon's count. The test still works.</p>}
      <div className="setting-actions">
        <button className="btn" onClick={() => void test()} disabled={!on || busy || testing}>
          Send a test notification
        </button>
        {!on && !unsupported && <span className="setting-hint">Turn notifications on to send a test.</span>}
        {result && (
          <span className="setting-result" role="status">
            {result}
          </span>
        )}
      </div>
    </section>
  );
}

function KeyboardSettings({ onShortcuts }: { onShortcuts: () => void }) {
  const singleKeys = useSingleKeys();
  return (
    <section className="settings-section" aria-labelledby="settings-keyboard">
      <h2 className="section-title" id="settings-keyboard">
        Keyboard
      </h2>
      <div className="setting">
        <div className="setting-text">
          <div className="setting-name" id="single-keys-name">
            Single-key shortcuts
          </div>
          <p className="setting-hint" id="single-keys-hint">
            Use J, K, P and M to work with the task in focus. These keys rest while you type.
          </p>
        </div>
        <Switch on={singleKeys} onToggle={() => setSingleKeys(!singleKeys)} labelledBy="single-keys-name" describedBy="single-keys-hint" />
      </div>
      <div className="setting-actions">
        <button className="btn" onClick={onShortcuts}>
          Keyboard shortcuts
        </button>
      </div>
    </section>
  );
}
