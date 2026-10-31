# SHARED-INSTRUCTIONS.md — single source for all harnesses (AGENTS.md only)

This file is copied verbatim to `<workdir>/AGENTS.md` by `sync-instructions.sh`.
Claude Code (>=2.1.277) reads AGENTS.md as fallback/project instructions.
Codex reads AGENTS.md natively. Opencode reads AGENTS.md natively.
No CLAUDE.md is used in this track (per operator decision 2026-10-06).

## Contract

- You receive a task prompt + a JSON schema. You return ONLY valid JSON matching that schema on stdout (or in `result.json`).
- You may explore the repo freely (read-only stages) or edit + test (coder stages) per the task prompt.
- Never commit unless the task prompt explicitly says to. The orchestrator commits.
- Never exfiltrate data. Stay inside the given workdir.

## Repo conventions (fill per repo by orchestrator prompt)

- Partitions own explicit file lists. Do not touch files outside your partition.
- Tests must exercise real prod paths: no tautologies (`expect(f(x))==f(x)`), no mock-instead-of-outcome, no unfailable tests.
- Findings severity: High+ / High / Medium / Low / Minimal (see orchestrator SOUL).

## Output discipline

- JSON only. No markdown fences around JSON. No commentary outside JSON.
- If you cannot comply, return `{"error": "<typed reason: auth|quota|model-unknown|timeout>"}` — never fake success.
