# Ecosystem Validator

Validate all 8 grainulation packages are running, passing tests, and communicating.

## Context

The grainulation ecosystem has 8 packages, each with its own repo and port:

| Package       | Port | Repo                            |
|---------------|------|---------------------------------|
| farmer        | 9090 | ~/repo/grainulation/farmer      |
| wheat         | 9091 | ~/repo/grainulation/wheat       |
| barn          | 9093 | ~/repo/grainulation/barn        |
| mill          | 9094 | ~/repo/grainulation/mill        |
| silo          | 9095 | ~/repo/grainulation/silo        |
| harvest       | 9096 | ~/repo/grainulation/harvest     |
| orchard       | 9097 | ~/repo/grainulation/orchard     |
| grainulation  | 9098 | ~/repo/grainulation/grainulation|

## Instructions

### Step 1: Detect grainulation root

Derive the grainulation root from `$HOME/repo/grainulation`. Do not hardcode absolute paths -- use `$HOME` or detect from the current working directory by walking up to find the `grainulation/` parent. Confirm the directory exists before proceeding.

### Step 2: Health probe all 8 ports

For each package, run `curl -s -o /dev/null -w "%{http_code}" http://localhost:{port}/health` with a 3-second timeout. Record HTTP status or "DOWN" if unreachable. Run all 8 probes in parallel where possible.

### Step 3: Run unit tests

For each repo under the grainulation root, run `npm test` if a test script exists in package.json. Capture exit code and last 5 lines of output. Skip repos with no test script. Set a 60-second timeout per repo.

### Step 4: Test cross-tool HTTP calls

Test these integration paths by making HTTP requests:

- harvest -> barn: `curl http://localhost:9096/api/barn-check`
- orchard -> mill: `curl http://localhost:9097/api/mill-check`
- farmer -> wheat: `curl http://localhost:9090/api/wheat-status`
- silo -> harvest: `curl http://localhost:9095/api/harvest-check`

If a service is DOWN (from step 2), skip its integration tests. Record pass/fail for each path.

### Step 5: Report

Print a pass/fail matrix table in the terminal with columns: Package, Port, Health, Tests, Integration. Use "PASS", "FAIL", "SKIP", or "DOWN" as values. End with a summary line: total passing, total failing, total down.

If any package is FAIL or DOWN, list the specific errors below the table grouped by package.
