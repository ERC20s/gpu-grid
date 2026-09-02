Developer notes

Run the unit tests

- Create a virtual environment and install test/runtime deps:

  python -m venv .venv
  source .venv/bin/activate
  pip install pytest requests

- Run pytest:

  pytest -q

Run the scheduler tests

- The scheduler has its own Node tests (no dependencies to install):

  cd scheduler
  npm test

- npm test runs both test files in sequence and must print "All tests passed"
  (scheduler/test/matcher.test.js) and then "Hosts tests passed"
  (scheduler/test/hosts.test.js), exiting 0.

- To run one at a time while working on a single area:

  npm run test:matcher
  npm run test:hosts

- test/hosts.test.js starts the exported server from scheduler/index.js on an
  ephemeral port (server.listen(0)) and exercises POST /hosts, GET /hosts and
  POST /match — the same HTTP surface scripts/gridctl.py posts to — so it needs
  no fixed port and no GPU.

Run the CLI against a local scheduler

- The scripts/gridctl.py provides a minimal CLI. For example, with a local test server listening on port 8000:

  python scripts/gridctl.py --scheduler-url http://localhost:8000 --job-file tests/fixtures/simple_job.json

Notes

- Tests use a small builtin HTTPServer so no network access or GPUs are required.
- Keep dependencies minimal: requests and pytest are sufficient for the tests in this change.
