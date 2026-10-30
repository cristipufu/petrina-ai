import type { Product } from "@petrina/core";
export interface RepositoryNavigation { title: string; body: string }
import * as git from "@petrina/repositories/git";
import { readObjects, treeNames } from "./object-batch.js";

/** Keep navigation paths on one line without hiding readable Unicode names. */
const shownPath = (path: string) => /[\x00-\x1f\x7f"\\]/.test(path) ? JSON.stringify(path) : path;

/** Bounded source facts for navigation, never another agent's conclusions. */
export class RepoOrientation {
  private readonly packets = new Map<string, Promise<RepositoryNavigation | undefined>>();

  async read(product: Product): Promise<RepositoryNavigation | undefined> {
    if (!product.path) return;
    const tree = await git.treeOf(product.path, `refs/heads/${product.defaultBranch ?? "main"}`);
    if (!tree) return;
    const key = `${product.id}:${product.name}:${product.path}:${tree}`;
    const cached = this.packets.get(key);
    if (cached) return cached;
    const packet = this.prepare(product, tree).catch(() => { this.packets.delete(key); return undefined; });
    this.packets.set(key, packet);
    while (this.packets.size > 32) this.packets.delete(this.packets.keys().next().value!);
    return packet;
  }

  private async prepare(product: Product, tree: string): Promise<RepositoryNavigation> {
    const path = product.path!;
    const [listed, ...documents] = await readObjects(path, [tree, ...["package.json", "AGENTS.md", "README.md"].map(file => `${tree}:${file}`)]);
    if (!listed) throw new Error("Repository navigation is unavailable.");
    const [manifest, agents, readme] = documents.map(document => document?.type === "blob" ? document.body.toString("utf8") : undefined);
    const top = treeNames(listed).slice(0, 60);
    const packages: string[] = [];
    const folders = ["packages", "apps"].filter(folder => top.includes(folder));
    const children = await readObjects(path, folders.map(folder => `${tree}:${folder}`));
    for (const [index, child] of children.entries()) if (child?.type === "tree") {
      packages.push(...treeNames(child).slice(0, 12).map(name => `${folders[index]}/${name}`));
    }
    const names = packages.slice(0, 12), files = await readObjects(path, names.map(name => `${tree}:${name}/package.json`));
    const manifests = files.map((file, index) => {
      const text = file?.type === "blob" ? file.body.toString("utf8") : undefined;
      if (!text) return;
      try { const value = JSON.parse(text); return `${shownPath(names[index]!)}: ${JSON.stringify({ name: value.name, scripts: value.scripts })}`; } catch { return; }
    });
    let scripts = "";
    try { const value = JSON.parse(manifest ?? "{}"); scripts = JSON.stringify({ workspaces: value.workspaces, scripts: value.scripts }); } catch { /* Optional navigation. */ }
    const body = [
      `Product ${product.id}; local default branch ${product.defaultBranch ?? "main"}; exact tree ${tree}. Navigation only, not a plan or requirements. A selected branch or pull request may differ. Inspect the actual source before deciding scope or risk. Nothing was fetched or executed.`,
      `Top-level paths (up to 60):\n${top.map(shownPath).join("\n")}`,
      scripts ? `Declared root workspace/scripts:\n${scripts}` : "",
      manifests.some(Boolean) ? `Workspace manifests (up to 12):\n${manifests.filter(Boolean).join("\n")}` : "",
      agents ? `AGENTS.md excerpt (up to 4,000 characters; read the complete file at this version before acting):\n${agents.slice(0, 4_000)}` : "",
      readme ? `README introduction (up to 1,500 characters; partial):\n${readme.slice(0, 1_500)}` : "",
    ].filter(Boolean).join("\n\n");
    return { title: `Repository navigation: ${product.name}`, body: body.slice(0, 14_000) + (body.length > 14_000 ? "\nNavigation excerpt truncated; inspect the repository for the rest." : "") };
  }
}
