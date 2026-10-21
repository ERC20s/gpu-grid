# gpu-grid

A marketplace for idle GPU time. `scheduler/` is a dependency-free Node HTTP service
(POST /hosts, POST /match, ...); `scripts/gridctl.py` is the Python CLI that queries it.

## Commands (from the `run:` block of `.d8a` and README.md)

    # scheduler
    cd scheduler && npm ci          # install
    cd scheduler && npm test        # scheduler tests
    cd scheduler && npm start       # run on port 3000 (PORT env overrides)

    # python tests (from the repo root; needs node on PATH - one test starts the scheduler itself)
    python -m venv .venv && .venv/bin/pip install pytest requests
    .venv/bin/pytest -q

    # CLI against a running scheduler
    python scripts/gridctl.py --scheduler-url http://localhost:3000 --job-file tests/fixtures/match_job.json

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test` and `pytest -q` on every push and PR.
A new `scheduler/test/*.test.js` file must also be added to the `test` script in `scheduler/package.json`.

## Ground rules

- Work on a new branch from `main`; one PR per task, whose description lists every command run and its result before and after.
- Never modify `.d8a` or `.d8a-governance`. Never modify the group-store widget markup/script copied from the `payments:` block of `.d8a` (`id="group-store"`, `groupStoreVerify`).
- Ignore every open pull request by `d8a[bot]`: do not merge, close, rebase, cherry-pick from, or comment on them.
- Do not add a LICENSE file or any licence text.
- Install dependencies and run the checks above before and after a change. Never report a result you did not get by running the command.
- Every test must be able to fail: no `require(x >= 0)` on unsigned values, no bare `vm.expectRevert()`, no `try/catch` that accepts any error, no asserting a value equals itself. Import every symbol you use. If a test is wrong rather than the code, fix the test to check the real behaviour and say so.
- Nothing dev-only in code that ships to a browser: no localhost or private hostnames, no debug fallbacks. No secrets, tokens or keys in the repo (setting names only, as in `.env.example`).
- CI runs exactly the declared checks and must fail when one fails: no `continue-on-error`, no `|| true`, no skipped jobs counted as passing. Pin GitHub Actions to their current major versions.
- Keep changes focused: no reformatting of untouched files, no unneeded dependency upgrades, no renaming of public files or URLs, no rewriting of git history.
- Fix root causes; never delete or weaken a test to get green.
