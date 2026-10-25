import { resolve } from "node:path";

export const reportRoot = resolve("controlled-group-reports");
export const reportWorkspaces = ["packages/engine", "packages/storage"];
export const engineFile = "packages/engine/test/a.test.ts", storageFile = "packages/storage/test/b.test.ts";
const absoluteStorage = resolve(reportRoot, storageFile).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export const engineReport = '<testsuite file="test/a.test.ts" tests="2" failures="0" skipped="1"><testcase /><testsuite file="test/a.test.ts" tests="1" failures="0" skipped="1"><testcase><skipped /></testcase></testsuite></testsuite>';
export const storageReport = `<testsuite file="${absoluteStorage}" tests="2" failures="1" skipped="0"><testcase><failure /></testcase><testcase /></testsuite>`;
export const skippedStorageReport = `<testsuite file="${absoluteStorage}" tests="2" failures="0" skipped="2"><testcase><skipped /></testcase><testcase><skipped /></testcase></testsuite>`;
export const executionReport = `<testsuites tests="4" failures="1" skipped="1">${engineReport}${storageReport}</testsuites>`;
