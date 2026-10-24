export const WORKSPACES = ["packages/core", "packages/engine", "apps/desktop"] as const;
export const isTest = (file: string): boolean => /(?:^|\/)(?:[^/]+[._])?(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
export const isSource = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file);
export const workspaceOf = (file: string): string | undefined => WORKSPACES.find(workspace => file.startsWith(`${workspace}/`));
