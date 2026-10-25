import type { Product } from "@petrina/core";
export interface RepositoryNavigation { title: string; body: string }
import * as git from "@petrina/repositories/git";

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
    const [listed, manifest, agents, readme] = await Promise.all([
      git.run(["git", "ls-tree", "--name-only", tree], path),
      git.fileAt(path, tree, "package.json"), git.fileAt(path, tree, "AGENTS.md"), git.fileAt(path, tree, "README.md"),
    ]);
    if (listed.code) throw new Error("Repository navigation is unavailable.");
    const top = listed.stdout.split("\n").slice(0, 60);
    const packages: string[] = [];
    for (const folder of ["packages", "apps"]) if (top.includes(folder)) {
      const children = await git.run(["git", "ls-tree", "--name-only", `${tree}:${folder}`], path);
      if (!children.code) packages.push(...children.stdout.split("\n").filter(Boolean).slice(0, 12).map((name) => `${folder}/${name}`));
    }
    const manifests = await Promise.all(packages.slice(0, 12).map(async (name) => {
      const text = await git.fileAt(path, tree, `${name}/package.json`);
      if (!text) return;
      try { const value = JSON.parse(text); return `${name}: ${JSON.stringify({ name: value.name, scripts: value.scripts })}`; } catch { return; }
    }));
    let scripts = "";
    try { const value = JSON.parse(manifest ?? "{}"); scripts = JSON.stringify({ workspaces: value.workspaces, scripts: value.scripts }); } catch { /* Optional navigation. */ }
    const body = [
      `Product ${product.id}; local default branch ${product.defaultBranch ?? "main"}; exact tree ${tree}. Navigation only, not a plan or requirements. A selected branch or pull request may differ. Inspect the actual source before deciding scope or risk. Nothing was fetched or executed.`,
      `Top-level paths (up to 60):\n${top.join("\n")}`,
      scripts ? `Declared root workspace/scripts:\n${scripts}` : "",
      manifests.some(Boolean) ? `Workspace manifests (up to 12):\n${manifests.filter(Boolean).join("\n")}` : "",
      agents ? `AGENTS.md excerpt (up to 4,000 characters; read the complete file at this version before acting):\n${agents.slice(0, 4_000)}` : "",
      readme ? `README introduction (up to 1,500 characters; partial):\n${readme.slice(0, 1_500)}` : "",
    ].filter(Boolean).join("\n\n");
    return { title: `Repository navigation: ${product.name}`, body: body.slice(0, 14_000) + (body.length > 14_000 ? "\nNavigation excerpt truncated; inspect the repository for the rest." : "") };
  }
}
