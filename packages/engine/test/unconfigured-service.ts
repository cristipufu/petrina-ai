// A fixture's missing service must fail locally, never fall through to an installed CLI or account.
console.error(`This test must supply a scripted ${process.argv[2] ?? "service"} command.`);
process.exitCode = 1;
