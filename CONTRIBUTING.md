Developer notes

Run the unit tests

- Create a virtual environment and install test/runtime deps:

  python -m venv .venv
  source .venv/bin/activate
  pip install pytest requests

- Run pytest:

  pytest -q

Run the CLI against a local scheduler

- The scripts/gridctl.py provides a minimal CLI. The scheduler in this repository listens on
  port 3000 (cd scheduler && npm start), so:

  python scripts/gridctl.py --scheduler-url http://localhost:3000 --job-file tests/fixtures/simple_job.json

  The CLI wraps the job file as {"job": ...} for POST /match and prints the ranked hosts from
  the {"matches": [...]} response. See the gridctl section of README.md for exit codes.

Notes

- Tests use a small builtin HTTPServer so no network access or GPUs are required.
- Keep dependencies minimal: requests and pytest are sufficient for the tests in this change.
