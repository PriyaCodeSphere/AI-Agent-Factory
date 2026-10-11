# MRP Agent Demo: Team Guide

This guide is the quickest way to understand, demonstrate, and extend the MRP
Exception Management demo.

## Shared demo

- URL: https://mrp-agent-demo.onrender.com
- Access: public; no username or password is currently required
- Model: the hosted service uses the configured Azure OpenAI deployment
- Concurrency: one scenario can run at a time

The service runs on Render's free plan, so the first request after an idle period
can take longer than usual. A scenario makes live Azure OpenAI calls and can take
roughly 20-40 seconds depending on the lane and model response time.

Do not enter real customer, supplier, employee, or production ERP data. The demo
uses synthetic in-memory fixtures and is intended for demonstration and development.

## What the demo proves

The demo shows an agentic MRP exception workflow operating across a simulated
multi-ERP network. The agents do not follow a prerecorded script. They inspect
the current fixture data, use typed ERP tools, recommend a corrective path, and
either act, stop at a human gate, or refuse to act when a guardrail blocks them.

The central design principle is:

> Agents judge; deterministic workflow code routes and governs their decisions.

The implementation contains 16 agent personas, 15 ERP-style integrations, nine
corrective paths, an explicit engineering approval gate, and tool-level safety
checks derived from the business requirements.

## Choose a scenario

| Scenario | What it demonstrates | Expected outcome |
| --- | --- | --- |
| Lane A | Autonomous resolution using an engineering-documented substitute | The shortage is cleared with no human gate |
| Lane B | A new substitute that requires engineering governance | The workflow stops for an engineering decision, then proceeds or holds |
| Refusal | A feasible transfer based on stale inventory data | The agent refuses the transaction and escalates under NFR-14 |

For a first walkthrough, run the lanes in this order: Lane A, Lane B, then
Refusal. Lane A establishes the happy path, Lane B demonstrates human control,
and Refusal shows why the guardrails matter.

## Reading the UI

1. Select a scenario card.
2. For Lane B, choose the engineering decision before starting the run.
3. Select **Run live scenario**.
4. Follow the timeline from top to bottom.
5. Review the summary metrics after the run completes.

The timeline distinguishes agent turns, ERP tool calls, routing decisions,
human gates, and escalations. The summary reports agent turns, tool calls,
human gates, escalations, elapsed agent time, and token usage.

If another run is active, the server returns a conflict instead of mixing the
two executions. Wait for the current run to finish and try again.

## System flow

```text
Browser
  -> POST /api/runs
  -> scenario setup
  -> deterministic orchestrator
  -> agent decision
  -> validated ERP tool call
  -> routing rule or human gate
  -> scoped MRP replanning
  -> result verification
  -> Server-Sent Events timeline
```

The mock ERP is reset for each scenario. All state is held in memory, so a
service restart also resets the demo.

## Code map

| Area | File | Responsibility |
| --- | --- | --- |
| Scenario entry points | `src/scenarios.ts` | Prepares Lane A, Lane B, and Refusal |
| Workflow | `src/orchestrator.ts` | Routes recommendations and enforces the human gate |
| Agent catalog | `src/agents/registry.ts` | Defines all 16 agents, prompts, tools, FRs, and guardrails |
| Agent execution | `src/agents/run.ts` | Runs model turns and requires structured completion or escalation |
| ERP tools | `src/erp/tools.ts` | Defines typed reads, writes, validations, and audit events |
| Demo data | `src/erp/fixtures.ts` | Synthetic plants, inventory, suppliers, materials, and exceptions |
| ERP state | `src/erp/store.ts` | Holds and resets the in-memory ERP model |
| Model client | `src/llm/client.ts` | Configures Azure OpenAI requests |
| Trace model | `src/trace.ts` | Captures events, timings, token usage, and summary metrics |
| Web server | `src/server.ts` | Serves the UI, run API, SSE stream, and health endpoints |
| Browser UI | `public/` | Scenario selection, live timeline, and run summary |
| Regression checks | `src/selftest.ts` | Protects arithmetic, routing paths, fixtures, and guardrails |

## Run locally

Requirements:

- Node.js 23.6 or newer
- pnpm
- An Azure OpenAI endpoint, API key, and chat deployment

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm selftest
pnpm typecheck
pnpm start
```

Open http://localhost:3000. Keep `.env` local; it is ignored by Git.

Useful command-line runs:

```bash
pnpm lane-a
pnpm lane-b
pnpm lane-b-reject
pnpm refusal
pnpm all
```

To record a trace for analysis:

```bash
node --env-file=.env src/cli.ts lane-a --trace-out ./traces
```

The `traces/` directory is ignored by Git.

## Safe ways to make changes

### Change fixture data

Edit `src/erp/fixtures.ts`, then run `pnpm selftest`. Fixture changes can open a
new corrective path and silently change the scenario an agent selects. Pay
special attention to the Refusal lane isolation checks.

### Change an agent

Edit `src/agents/registry.ts`. Preserve the functional requirement IDs, quoted
guardrails, permitted tools, and escalation route. An agent should complete via
its structured submission tool or explicitly escalate; free text is not treated
as a successful result.

### Add or change an ERP tool

Work in `src/erp/tools.ts` and keep validation at the tool boundary. Reads and
writes should use typed schemas, validate identifiers, emit trace events, and
record enough before/after context for an audit trail.

### Change routing

Work in `src/orchestrator.ts`. Routing rules and human approval gates belong in
deterministic code, not in an agent prompt.

### Change the UI

The frontend is dependency-free HTML, CSS, and JavaScript in `public/`. Keep the
SSE event shapes aligned with `src/trace.ts` and the API behavior in
`src/server.ts`.

## Verification checklist

Run these before opening a pull request or starting a customer demo:

```bash
pnpm selftest
pnpm typecheck
```

Then run the affected lane locally and confirm:

- the expected corrective path is selected;
- the timeline includes the expected tools, decisions, gates, or escalation;
- no write occurs after a rejection or refusal;
- the final shortage and run metrics are sensible;
- `.env`, traces, and credentials are not staged for commit.

## Hosted deployment

The shared service tracks the repository's `main` branch and deploys on new
commits. Render uses:

- build command: `pnpm install --frozen-lockfile`
- start command: `npm start`
- health check: `/healthz`
- service region: Ohio
- plan: free

The live service currently has no application-level password. Anyone with the
URL can start a run, and every completed scenario consumes Azure OpenAI tokens.
Add `DEMO_PASSWORD` in Render to restore Basic Authentication; optionally set
`DEMO_USERNAME`, which defaults to `demo`.

Never commit Azure credentials. Configure them only in the Render environment:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_CHAT_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_REASONING`

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The first page load is slow | The free service may be starting after an idle period |
| A run says another run is active | Wait for the current scenario to finish |
| The UI says Azure is not configured | Check the three required Azure settings in Render or `.env` |
| A scenario chooses a surprising path | Review fixture changes and the recommending agent trace |
| Refusal no longer refuses | Run `pnpm selftest` and inspect the refusal fixture isolation |
| Build fails while enabling Corepack | Use the existing `pnpm` command directly on Render |
| TypeScript imports fail | Confirm the Node version meets the requirement in `package.json` |

For detailed design rationale, requirements mapping, and lessons learned, see
the main [README](README.md).
