# Review guide

Reviewers check every change against these points.

- When a change or fix alters one case, check the nearby cases (other keys doing the same thing, other window sizes, other ways in and out) still work as before; anything that used to work and now doesn't blocks the change.
- Keep the required engine test suite fully parallel. Diagnose slow fixtures and process startup without reducing workers or adding automatic retries to make the required run pass; focused diagnostic runs may use different settings.
