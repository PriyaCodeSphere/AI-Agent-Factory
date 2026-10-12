const state = { lane: "lane-a", running: false, source: null, runId: null, agents: [], agentFilter: "all" };
const $ = (selector) => document.querySelector(selector);

const cards = [...document.querySelectorAll(".scenario-card")];
const runButton = $("#run-button");
const timeline = $("#timeline");
const emptyState = $("#empty-state");
const runStatus = $("#run-status");
const approvalPanel = $("#approval-panel");

function setLane(lane) {
  state.lane = lane;
  cards.forEach((card) => card.classList.toggle("selected", card.dataset.lane === lane));
}

cards.forEach((card) => card.addEventListener("click", () => !state.running && setLane(card.dataset.lane)));

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function displayName(value) {
  return String(value).replace(/_agent$/, "").replaceAll("_", " ");
}

function switchView(view) {
  $("#factory-view").hidden = view !== "factory";
  $("#runtime-view").hidden = view !== "runtime";
  document.querySelectorAll(".view-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.view === view),
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAgentDetail(agent) {
  if (!agent) return;
  document.querySelectorAll(".agent-row").forEach((row) =>
    row.classList.toggle("selected", row.dataset.agent === agent.name),
  );
  const tools = agent.tools.map((tool) =>
    `<li><strong>${escapeHtml(displayName(tool.name))}</strong><span>${escapeHtml(tool.description)}</span></li>`,
  ).join("");
  const guardrails = agent.guardrails.map((guardrail) =>
    `<li><span>${escapeHtml(guardrail.id)}</span><p>${escapeHtml(guardrail.text)}</p></li>`,
  ).join("");
  $("#agent-detail").innerHTML = `
    <div class="agent-title"><div><span>${escapeHtml(agent.fr)} / BRD-DERIVED PERSONA</span><h3>${escapeHtml(displayName(agent.name))}</h3></div><span class="autonomy-badge ${escapeHtml(agent.autonomy)}">${escapeHtml(agent.autonomy)} autonomy</span></div>
    <p class="agent-mission">${escapeHtml(agent.mission)}</p>
    <div class="contract-metrics"><div><span>Design confidence</span><strong>${escapeHtml(agent.confidence)}%</strong></div><div><span>Reasoning effort</span><strong>${escapeHtml(agent.effort)}</strong></div><div><span>Allowed tools</span><strong>${agent.tools.length}</strong></div><div><span>Guardrails</span><strong>${agent.guardrails.length}</strong></div></div>
    <section class="contract-section"><h4>Requirement origin</h4><p>${escapeHtml(agent.fr)} defines this responsibility in the BRD. Its acceptance criteria become the agent mission and expected output contract.</p></section>
    <section class="contract-section"><h4>Bounded capabilities</h4><ul class="tool-list">${tools}</ul></section>
    <section class="contract-section"><h4>Mandatory controls</h4><ul class="guardrail-list">${guardrails}<li class="escalation-rule"><span>${escapeHtml(agent.escalation.id)}</span><p>${escapeHtml(agent.escalation.text)}</p></li></ul></section>`;
}

function renderAgentList() {
  const visible = state.agents.filter((agent) => state.agentFilter === "all" || agent.autonomy === state.agentFilter);
  $("#agent-list").innerHTML = visible.map((agent) => `
    <button class="agent-row" data-agent="${escapeHtml(agent.name)}" type="button" role="listitem">
      <span>${escapeHtml(agent.fr)}</span><div><strong>${escapeHtml(displayName(agent.name))}</strong><small>${escapeHtml(agent.mission)}</small></div><b>${escapeHtml(agent.confidence)}%</b>
    </button>`).join("");
  document.querySelectorAll(".agent-row").forEach((row) => row.addEventListener("click", () =>
    renderAgentDetail(state.agents.find((agent) => agent.name === row.dataset.agent)),
  ));
  renderAgentDetail(visible[0]);
}

async function loadBlueprint() {
  try {
    const response = await fetch("/api/blueprint");
    if (!response.ok) throw new Error("Blueprint unavailable");
    const blueprint = await response.json();
    state.agents = blueprint.agents;
    renderAgentList();
  } catch (error) {
    $("#agent-detail").innerHTML = `<div class="detail-empty">${escapeHtml(error.message)}</div>`;
  }
}

function eventView(event) {
  const views = {
    lane: ["lane", "Scenario started", event.label],
    agent_start: ["agent", event.agent.replaceAll("_", " "), event.fr],
    agent_end: ["complete", `${event.agent.replaceAll("_", " ")} completed`, `${(event.ms / 1000).toFixed(1)}s · ${event.inputTokens} in / ${event.outputTokens} out`],
    tool: ["tool", event.tool.replaceAll("_", " "), `${event.fr} · ${event.summary}`],
    decision: ["decision", `${event.rule} · ${event.question}`, event.outcome],
    escalation: ["escalation", `Escalated · ${event.nfr}`, event.reason],
    human_gate: ["gate", `Human gate · ${event.fr}`, `${event.actor}: ${event.outcome}`],
    note: ["note", "Workflow", event.text],
  };
  return views[event.kind] ?? ["note", event.kind, ""];
}

function addEvent(event) {
  if (event.kind === "note" && !event.text.trim()) return;
  emptyState.hidden = true;
  const [kind, title, detail] = eventView(event);
  const item = document.createElement("article");
  item.className = `event event-${kind}`;
  item.innerHTML = `<div class="event-node"></div><div class="event-copy"><span>${escapeHtml(kind)}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`;
  timeline.append(item);
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setMetrics(summary) {
  $("#metric-agents").textContent = summary?.agentTurns ?? "—";
  $("#metric-tools").textContent = summary?.toolCalls ?? "—";
  $("#metric-gates").textContent = summary?.humanGates ?? "—";
  $("#metric-escalations").textContent = summary?.escalations ?? "—";
  $("#metric-time").textContent = summary ? `${(summary.agentWallClockMs / 1000).toFixed(1)}s` : "—";
}

function resetTrace() {
  timeline.innerHTML = "";
  emptyState.hidden = false;
  setMetrics(null);
  runStatus.textContent = "Ready";
  runStatus.className = "";
  approvalPanel.hidden = true;
  $("#approval-error").textContent = "";
}

function showApproval(decisionPackage) {
  switchView("runtime");
  $("#approval-exception").textContent = decisionPackage.exceptionId;
  $("#approval-material").textContent = decisionPackage.affectedMaterial;
  $("#approval-substitute").textContent = decisionPackage.proposedSubstitute;
  $("#approval-support").textContent = decisionPackage.engineeringSupportAvailable;
  $("#approval-gaps").innerHTML = decisionPackage.gapsForEngineering
    .map((gap) => `<li>${escapeHtml(gap)}</li>`)
    .join("");
  approvalPanel.hidden = false;
  approvalPanel.querySelectorAll("button").forEach((button) => (button.disabled = false));
  runStatus.textContent = "Awaiting approval";
  runStatus.className = "awaiting";
  runButton.querySelector("span").textContent = "Waiting for engineering";
  approvalPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function submitDecision(decision) {
  if (!state.runId) return;
  const buttons = [...approvalPanel.querySelectorAll("button")];
  buttons.forEach((button) => (button.disabled = true));
  $("#approval-error").textContent = "";
  try {
    const response = await fetch(`/api/runs/${state.runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to submit decision");
    approvalPanel.hidden = true;
    runStatus.textContent = "Running";
    runStatus.className = "running";
    runButton.querySelector("span").textContent = "Agents working…";
  } catch (error) {
    $("#approval-error").textContent = error.message;
    buttons.forEach((button) => (button.disabled = false));
  }
}

function finish(payload) {
  state.running = false;
  runButton.disabled = false;
  cards.forEach((card) => (card.disabled = false));
  runButton.querySelector("span").textContent = "Run live scenario";
  setMetrics(payload.summary);
  runStatus.textContent = payload.status === "completed" ? "Completed" : "Failed";
  runStatus.className = payload.status;
  if (payload.error) addEvent({ kind: "escalation", nfr: "SERVER", reason: payload.error });
  state.source?.close();
  state.source = null;
  state.runId = null;
  approvalPanel.hidden = true;
}

async function startRun() {
  if (state.running) return;
  resetTrace();
  state.running = true;
  runButton.disabled = true;
  cards.forEach((card) => (card.disabled = true));
  runButton.querySelector("span").textContent = "Agents working…";
  runStatus.textContent = "Starting";
  runStatus.className = "running";

  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: state.lane }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to start run");

    state.runId = payload.id;
    runStatus.textContent = "Running";
    const source = new EventSource(`/api/runs/${payload.id}/events`);
    state.source = source;
    source.addEventListener("trace", (message) => addEvent(JSON.parse(message.data)));
    source.addEventListener("approval_required", (message) => showApproval(JSON.parse(message.data)));
    source.addEventListener("approval_resolved", () => {
      approvalPanel.hidden = true;
    });
    source.addEventListener("complete", (message) => finish(JSON.parse(message.data)));
    source.onerror = () => {
      if (state.running && source.readyState === EventSource.CLOSED) finish({ status: "failed", error: "The live event connection closed unexpectedly." });
    };
  } catch (error) {
    finish({ status: "failed", error: error.message });
  }
}

async function checkHealth() {
  const label = $("#system-state");
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    label.classList.toggle("offline", !health.configured);
    label.querySelector("span:last-child").textContent = health.configured ? `${health.deployment} · Ready` : "Azure configuration needed";
  } catch {
    label.classList.add("offline");
    label.querySelector("span:last-child").textContent = "Server unavailable";
  }
}

runButton.addEventListener("click", startRun);
document.querySelectorAll(".view-tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => {
  state.agentFilter = button.dataset.filter;
  document.querySelectorAll(".filter-button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  renderAgentList();
}));
$("#explore-agents").addEventListener("click", () => $("#agent-workforce").scrollIntoView({ behavior: "smooth" }));
$("#open-runtime").addEventListener("click", () => switchView("runtime"));
document.querySelectorAll(".decision-button").forEach((button) =>
  button.addEventListener("click", () => submitDecision(button.dataset.decision)),
);
$("#clear-button").addEventListener("click", () => !state.running && resetTrace());
setLane("lane-a");
checkHealth();
loadBlueprint();
