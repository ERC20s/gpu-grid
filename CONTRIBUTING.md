Developer notes

Run the unit tests

- Create a virtual environment and install test/runtime deps:

  python -m venv .venv
  source .venv/bin/activate
  pip install pytest requests

- Run pytest:

  pytest -q

Run the CLI against a local scheduler

- The scripts/gridctl.py provides a minimal CLI. For example, with a local test server listening on port 8000:

  python scripts/gridctl.py --scheduler-url http://localhost:8000 --job-file tests/fixtures/simple_job.json

Notes

- Tests use a small builtin HTTPServer so no network access or GPUs are required.
- Keep dependencies minimal: requests and pytest are sufficient for the tests in this change.
