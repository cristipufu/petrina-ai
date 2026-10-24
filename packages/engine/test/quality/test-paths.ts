import { TEST_WORKSPACES } from "./workspaces.js";
export const WORKSPACES = TEST_WORKSPACES.map(workspace => workspace.path);
export const isTest = (file: string): boolean => /(?:^|\/)(?:[^/]+[._])?(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
export const isSource = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file);
export const workspaceOf = (file: string): string | undefined => WORKSPACES.find(workspace => file.startsWith(`${workspace}/`));
