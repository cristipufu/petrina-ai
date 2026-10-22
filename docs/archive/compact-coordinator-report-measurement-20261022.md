# Historical measurement: compact coordinator reports, October 22, 2026

This records task-82772's comparison, not a current specification or a performance guarantee. Current behavior is described in [checkpoint and review reports](../coordination-reports.md).

The focused `checkpoint-read.test.ts` fixture reconstructed the previous inspection projection using the same evidence pager and envelope. Its delivery contains four passing checks (Types, Web build, Tests, Desktop shell), each with 6,000 saved output characters; recorded commit/tree/definition identities and timings; a two-stage plan; a design brief and passed acceptance item; a saved reviewer result; and two open nonblocking reports (one nit, one pre-existing follow-up). Both views contain the same actual checkpoint request and decision choices/revision. No original check logs are guessed where the fixture only retains saved output.

Measured with Bun 1.4.2 on macOS, using the default 8,000-character inspection budget:

| Complete inspection | Previous projection | Compact projection |
| --- | ---: | ---: |
| Content characters across all pages | 29,107 | 6,564 |
| Complete JSON response characters, summed across all pages | 32,550 | 7,810 |
| Default pages | 4 | 1 |

The response measure includes the repeated decision envelope and continuation references, rather than measuring only its evidence text. All fixture text is ASCII, so these response-character counts are also UTF-8 byte counts. The regression then adds 23,000 successful output characters to each check: the compact content and complete response sizes stay identical, while the evidence revision still changes. The actual request, acceptance state, open-report populations and original/fallback evidence references remain inspectable.

The supplied coordinator monitor capture was not inspected in this working copy. Its reported zero-Important/one-nit/one-follow-up case was reproduced in regression fixtures rather than treated as locally inspected evidence.
