# Existing header overlap: follow-up

Acceptance finding task-4463-29627 describes an older header problem. The branch/PR starting-point feature does not change the header. Its proposed phone-layout changes were removed from this task.

Headless comparisons against main on 18 October 2026 found identical header controls and positions in both demo views, in light and dark:

| Layout | Main and this task |
| --- | --- |
| Minimum desktop, 1100 × 680 | Fits |
| Usual desktop, 1680 × 1000 | Fits |
| 200% enlarged text at both desktop sizes | Fits |
| 200% zoom from the usual desktop size | Fits |
| 200% zoom from the minimum desktop size | The product selector's button area overlaps search in both versions |
| Phone width, 390 × 844 | The same overlapping controls and off-screen More button in both versions |

No new header regression was found. The existing phone and minimum-size zoom overlap needs a separate layout follow-up. The minimum supported desktop window remains 1100 × 680.

Before/after evidence, using the same demo and theme:

- Phone: [main](screenshots/header-follow-up-main-phone-follow-up.png), [this task](screenshots/header-follow-up-task-phone-follow-up.png).
- Minimum desktop at 200% zoom: [main](screenshots/header-follow-up-main-minimum-zoom-200.png), [this task](screenshots/header-follow-up-task-minimum-zoom-200.png).

The comparison used main at `0b0a6ab5b22374c26c8d7626150e55d4c501c4fa`. Zoom uses the equivalent layout viewport and doubled pixel density; enlarged text uses doubled text with the layout refreshed.

The same check was repeated after main moved to `3e8ab5f8aa0f2c7f709ab0ad2114d5802f350601`. Forty-two headless comparisons, both demo views and first run, in light and dark, matched main. The phone-width and minimum-size zoom overlaps are unchanged. At the usual desktop width with text doubled, New task and the theme control sit past the right edge on main and on this task alike. That is the same older layout, not a new regression.
