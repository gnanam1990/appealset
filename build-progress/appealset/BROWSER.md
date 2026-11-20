# AppealSet · Browser verification

Runnable check for the documented console journey in a real browser. Zero
npm dependencies — a minimal CDP client over Node's built-in WebSocket.

## Invocation

```sh
node scripts/browser-check.mjs
```

or with an explicit browser:

```sh
APPEALSET_BROWSER="/path/to/chrome-or-chromium" node scripts/browser-check.mjs
```

## Dependencies

- Node >= 22 (native TS stripping + built-in `WebSocket` client).
- A Chromium-family executable. Autodetect order:
  `APPEALSET_BROWSER` → `~/Library/Caches/ms-playwright/chromium_headless_shell-*`
  → Playwright `chromium-*` → system Chrome/Chromium (macOS + Linux paths).
- Nothing else: no `npm install`, no Playwright package.

## What it does

1. Creates a disposable db under `.tmp/browser-check-<pid>/`, provisions the
   roster with `apsk_` bearer credentials, starts the API + console on an
   ephemeral port (`devFixtures` off — the normal authenticated path).
2. Launches the browser with a disposable profile and opens four pages:
   reviewer-north, reviewer-south, expert, QA.
3. Exercises, all through the rendered console:
   - sign-in error visibility (bad credential → live-region error; the dev
     roster picker stays hidden in normal mode);
   - reviewer sign-in, role boundary (403 on a steward-scoped route);
   - blind workbench: pay disclosed (USD 0.10), no original label / producer
     org / peer identity;
   - final opinion submission, reload persistence of the credential session;
   - 320px viewport: no horizontal overflow, Tab traversal, Enter submits the
     final opinion;
   - expert adjudication over anonymized Slot 1/Slot 2 rationales → ruling B;
   - QA patch build by keyboard (Space checks the case, Enter builds),
     approve, export → human-readable "exported" outcome;
   - cost audit: 3 payable entitlements totaling 50 minor units (cap 50).
4. Writes a redacted evidence record (no tokens) to
   `build-progress/appealset/BROWSER-EVIDENCE.md`.

Env overrides: `APPEALSET_EVIDENCE` (output path), `APPEALSET_KEEP_TMP=1`
(keep the disposable dir for inspection).

## Environment notes

- The script launches Chromium with `--no-sandbox --single-process`. The
  profile is disposable and localhost-only; the flags also let the check run
  inside agent execution sandboxes that deny Chromium's launchd/Mach-port
  check-in (`bootstrap_check_in ... Permission denied`), which otherwise
  aborts startup on macOS. Drop `--single-process` locally if you want
  per-tab isolation — the script uses the `/json` HTTP endpoints, which work
  either way.
- Verified in-sandbox on 2026-11-20 against
  `chromium_headless_shell-1254` (arm64): 14/14 checks passed; see
  `BROWSER-EVIDENCE.md`.

## Gates kept separate

This is a local-only proof. It does not cover the external gates listed in
`STATUS.json` (live payment rail, SSO/IdP, partner consent feed, real-human
reviewer pools, managed Postgres).
