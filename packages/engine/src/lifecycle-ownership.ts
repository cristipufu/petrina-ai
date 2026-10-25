import type { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { type FolderLock, processAlive, readConnection } from "./instance.js";

/** The caller must own the folder. A quiet or starting owner must never be replaced. */
export function failAbandonedLifecycle(store: Pick<LifecycleStore, "current" | "failIfUnchanged">, home: string, _ownership: FolderLock): boolean {
    const operation = store.current;
    if (!operation || ["completed", "failed"].includes(operation.phase)) return false;
    // During the release-to-launch gap the previous owner is still alive. Afterwards the
    // recorded launcher owns startup, even before it has a connection or the folder lock.
    const pid = operation.phase === "starting" ? operation.launcherPid ?? readConnection(home)?.pid : readConnection(home)?.pid;
    // Older launchers did not record a process. Absence alone cannot prove startup failed.
    if (operation.phase === "starting" && !pid) return false;
    if (pid && processAlive(pid)) return false;
    return store.failIfUnchanged(operation, "The engine process exited before this lifecycle operation completed. Saved work is preserved.");
}
