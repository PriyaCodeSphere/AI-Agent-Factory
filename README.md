# MRP Exception Management — Agentic Demo

A working demo of the agent design in `end-to-end-mrp-exception-management-and-replanning-business-requirements.docx`, built to show a customer (AGCO).

One material shortage travels end to end through all 16 agents in the BRD against a mock multi-ERP backend. Nothing is scripted: the agents genuinely read the ERP data, genuinely choose one of nine corrective paths, and genuinely decline when a guardrail forbids the action.

For a practical team handoff covering the shared URL, scenario walkthroughs,
code map, change patterns, and verification checklist, see [TEAM_GUIDE.md](TEAM_GUIDE.md).

## Setup

Requires **Node 23.6+** (it runs TypeScript natively — no build step).

```bash
cp .env.example .env     # then fill in your Azure OpenAI details
pnpm install             # or npm install, see "Known environment issue" below
```

## Running

```bash
node --env-file=.env src/cli.ts selftest   # offline, no model calls, no credentials
node --env-file=.env src/cli.ts lane-a     # autonomous resolution
node --env-file=.env src/cli.ts lane-b     # governed resolution, stops at the human gate
node --env-file=.env src/cli.ts lane-b --reject   # engineering rejects; agents hold
node --env-file=.env src/cli.ts refusal    # an agent declines under NFR-14
node --env-file=.env src/cli.ts all        # all three in order

node --env-file=.env src/cli.ts lane-a --trace-out ./traces   # capture the run as JSON
```

### Web UI

Start the browser-based control room with:

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000). The UI lets you select any of the three lanes,
watch every agent/tool/decision event live, and review the final run metrics. Lane B pauses at FR-10,
displays the engineering decision package, and waits for a person to approve, request changes, or reject
before the workflow can continue. Azure credentials remain on the server and are never sent to the browser.
Runs are serialised because the demo ERP is intentionally an in-memory fixture.

Set `PORT` to use a port other than 3000. For a shared deployment, set `DEMO_PASSWORD` and optionally
`DEMO_USERNAME` (defaults to `demo`) to protect the site with browser Basic Authentication.

### Deploy to Render

The included `render.yaml` is ready for a Render Blueprint deployment:

1. Push this folder to a Git repository.
2. In Render, choose **New > Blueprint** and connect the repository.
3. Enter the secret values requested by the Blueprint: `AZURE_OPENAI_ENDPOINT`,
   `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_CHAT_DEPLOYMENT`.
4. Deploy and open the `onrender.com` URL Render assigns.

Do not commit `.env`; it is already excluded by `.gitignore`. Rotate any Azure key that has been pasted
into chat or another non-secret channel before deploying.

Run `selftest` before every demo. 47 checks over the mock ERP arithmetic, all nine corrective paths, the refusal lane's isolation, the registry, and the tool-level guardrails — about a second, no tokens spent.

## The three lanes

All three are verified against a live `gpt-4.1` Azure deployment. Timings below are measured.

**Lane A — autonomous.** `EX-77301`: HYD-PUMP-3045 short 120 units at plant 1010 (Marktoberdorf, SAP S/4 HANA), needed by 27 Oct, earliest supplier date 24 Nov. The agents triage the queue, evaluate all nine corrective paths against live data, apply the engineering-documented substitute, write to ERP with a real before/after record, replan and confirm the exception is cleared. No human touches it.

> 7 agent turns · 15 ERP tool calls · 0 escalations · ~25-29s · residual shortage 0

**Lane B — governed.** `EX-77302`: CAST-7781-GY short 32 units, sole-source vendor who cannot supply before 14 Dec, and **no engineering-documented substitute** — only a candidate that would need approval. The agents assemble a decision package and stop at FR-10, the one human gate in the whole future-state process. Approve and the engineering change is initiated, ERP is updated and the plan is resynchronised across [1010, 8010]. Reject (`--reject`) and the agents hold: nothing is written.

> 8 agent turns · 16 ERP tool calls · 1 human gate · ~29s · residual shortage 0

**Refusal lane — the agent declines.** `EX-77340`: BRG-5520-HD short 90 units at plant 2020 (Beauvais, SAP ECC). Sole-source vendor cannot supply before 20 Dec. No documented substitute, no approval candidate, no cross-brand equivalent, no safety stock, no allocations, no reschedulable orders. The only stock in the network is 150 units at Kansas City — more than enough, and it would arrive in time. The one thing wrong with it is that the availability figure last refreshed on 28 September. NFR-14 forbids reserving against a stale availability result, so the inventory agent escalates to the MRP controller and **no ERP changes are made**.

> 4 agent turns · 9 ERP tool calls · 1 escalation under NFR-14 · ~17s · nothing written

That third lane is the one worth rehearsing. Every vendor can demo the happy path.

The refusal only works because that material is deliberately isolated — nine `selftest` checks assert that isolation holds, because if a later fixture edit opens an easier path the recommending agent will take it and the refusal will quietly stop being demonstrated.

## How it maps to the BRD

| BRD artifact | Where it lives |
|---|---|
| 16 digital personas (§3) | [registry.ts](src/agents/registry.ts) — all 16 |
| 35 functional requirements (§7) | FR ids on every agent and tool |
| 15 tool integrations (FR-21…FR-35) | [tools.ts](src/erp/tools.ts), one Zod schema each |
| 55 NFR guardrails (§8) | Quoted verbatim into system prompts in [registry.ts](src/agents/registry.ts) |
| BR-01 / BR-02 (§6) | [orchestrator.ts](src/orchestrator.ts) — deterministic routing |
| FR-10 human gate (§9) | [orchestrator.ts](src/orchestrator.ts), the `new_substitution` branch |
| KPIs (§12) | [trace.ts](src/trace.ts) timing and token instrumentation |

### Design choices worth saying out loud

**Agents judge; the process routes.** FR-03 (an agent) recommends one of nine corrective paths. FR-04 / BR-01 — the routing of that recommendation — is ordinary deterministic code, because the BRD assigns it to the "Workflow Service". The agent never branches the process itself.

**Escalation is a tool, not a prompt instruction.** Every agent gets `escalate_to_controller` alongside its ERP tools. An agent that cannot act within its guardrails has a first-class way to say so, and the runner never synthesises a result from free text. See [run.ts](src/agents/run.ts).

**Guardrails are quoted, not paraphrased.** When the customer asks "what stops it doing X", you can point at the NFR id in the BRD and the identical line in the code.

**One deployment, per-agent effort.** All agents share one Azure deployment; only reasoning depth varies by agent (`effort` in [registry.ts](src/agents/registry.ts)). One deployment to govern and one cache namespace, rather than a fleet of models.

## What the live runs taught us

Worth knowing before you tune anything, because each of these cost a failed run to find.

**Give agents dates, not day-counts.** The recommending agent originally saw `quotedLeadTimeDays: 60` and had to add it to today's date to judge feasibility. It got this wrong repeatedly and recommended a path that could not possibly close the shortage in time. Adding an explicit `earliestAvailableDate` fixed it outright. Any comparison you want an agent to make reliably, give it pre-computed.

**An agent asked to produce an audit trail needs a way to read the "before".** FR-17's agent was given only a write tool, and it correctly escalated under NFR-31 rather than inventing a before-value. The tool is now read-then-write. The guardrail caught a genuine design gap, which is the system working.

**Validate identifiers at the tool boundary.** Agents invented plant ids (`HYDROPLANT01`) and vendor labels (`"CAST-7781-GY's primary source"`). Both now return an error listing the valid values, and the agent self-corrects on the next call. Without that, a mislabelled supplier request is indistinguishable from supplier silence.

**Guardrails can be read more broadly than intended.** NFR-08 ("do not bypass special engineering approval") sits in a list framed as *obey even if you cannot finish*, so the agent concluded the entire new-substitution path was off limits and never reached the human gate. The system prompt now states that routing work to a human approver is compliance, not bypass.

**Name the options.** The recommending agent originally saw nine bare enum names. It now gets a one-line definition of each, taken from the BRD's routing table.

## Known gaps

- **FR-13 (repaint the shared component) is a physical act** and stays out of scope, as the BRD states.
- **Lane A resolves via `documented_substitution`, not `alternate_inventory`.** Both are wired and both are valid on the data; the agent prefers the substitute. If you specifically want to show the network-wide inventory search on stage, drain Ennery in the Lane A setup.
- **`gpt-4.1` reasoning quality is the binding constraint on the recommending agent**, which the BRD rates at 86% confidence — the lowest on the critical path. Its rejection rationales are occasionally thin even when the chosen path is right. If one agent deserves a stronger deployment, it is this one.
- **The web UI serialises runs.** The mock ERP and trace collector are intentionally in-memory globals, so one live scenario runs at a time. A multi-user production service would isolate state per run.
- **ROI numbers are not populated.** The trace records per-agent wall clock and token usage, which gives you the agent side. The as-is baseline still has to come from interviews — the Solution Brief's slide 12 currently reads "Insufficient data".
- **Cost reporting is off by default.** Set `AZURE_INPUT_USD_PER_1M` and `AZURE_OUTPUT_USD_PER_1M` to your own rates. Unset, the summary says so rather than printing a guessed figure.
- The `effort` scale is five-level by design but Azure's `reasoning_effort` has three, so `xhigh` and `max` both collapse to `high`.
- **Fixture data is one material across five locations.** Enough for all nine paths; not enough to demo scale.

## Known environment issue

`npm install` fails on this machine with `Yallist is not a constructor` — an incompatibility between the bundled npm 11.6.0 and Node 26. Dependencies here were installed with pnpm instead:

```bash
node "$LOCALAPPDATA/node/corepack/v1/pnpm/12.11.2/bin/pnpm.mjs" install
```

Upgrading npm (`npm i -g npm@latest`, which may need IT) or using pnpm/yarn both resolve it. Worth fixing before the demo so you are not debugging it on the day.
