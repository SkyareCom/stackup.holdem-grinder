import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SOLVER_IDS, validateScenario } from "./spotEngine.js";

const CONFIG = {
  [SOLVER_IDS.DCFR]: {
    env: "STACKUP_DCFR_BIN",
    defaultBin: process.platform === "win32" ? "dcfr-solver.exe" : "dcfr-solver",
  },
  [SOLVER_IDS.GTOPEN]: { env: "STACKUP_GTOPEN_URL", defaultUrl: "http://127.0.0.1:3737" },
  [SOLVER_IDS.TEXAS]: { env: "STACKUP_TEXAS_SOLVER_BIN", defaultBin: process.platform === "win32" ? "console_solver.exe" : "console_solver" },
  [SOLVER_IDS.CFR_POKER]: { env: "STACKUP_CFR_POKER_BIN", defaultBin: "poker_solver" },
  [SOLVER_IDS.PREFLOP_RANGE]: { env: "STACKUP_PREFLOP_SOLVER_BIN", defaultBin: "poker_solver" },
};

const PREFLOP_CLASSES = 169;
const PREFLOP_RANKS = "23456789TJQKA";

const run = (command, args, { cwd, timeoutMs = 15 * 60_000 } = {}) => new Promise((ok, fail) => {
  const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); fail(new Error("solver timeout")); }, timeoutMs);
  child.stdout?.on("data", d => stdout += d);
  child.stderr?.on("data", d => stderr += d);
  child.on("error", e => { clearTimeout(timer); fail(e); });
  child.on("close", code => {
    clearTimeout(timer);
    code === 0 ? ok({ stdout, stderr }) : fail(new Error(command + " exited " + code + ": " + stderr.slice(-2000)));
  });
});

const outputPath = signature => resolve(process.env.STACKUP_SOLVER_OUTPUT_DIR || ".stackup/solves", Buffer.from(signature).toString("base64url").slice(0, 80) + ".json");
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));


export const DCFR_PREFLOP_PROFILE = Object.freeze({
  tableSize: 6,
  stackBb: 100,
  chipScale: 2,
  openSizeBb: 2.5,
  sbOpenSizeBb: 3.5,
  threeBetSizeBb: 9,
  fourBetSizeBb: 22,
  sbLimp: true,
  oopPotTax: 0.20,
});

const DCFR_POSTFLOP_ORDER = Object.freeze(["SB","BB","UTG","HJ","CO","BTN"]);

function dcfrPostflopRoles(positionA, positionB) {
  const a = DCFR_POSTFLOP_ORDER.indexOf(positionA);
  const b = DCFR_POSTFLOP_ORDER.indexOf(positionB);
  if (a < 0 || b < 0 || a === b) throw new Error("DCFR requires two distinct 6-max positions");
  return a < b
    ? { oopPosition: positionA, ipPosition: positionB }
    : { oopPosition: positionB, ipPosition: positionA };
}

export function dcfrRangeMapToString(range) {
  if (!range || typeof range !== "object" || Array.isArray(range)) throw new Error("DCFR range map required");
  const entries = Object.entries(range)
    .filter(([, weight]) => Number(weight) > 0)
    .sort(([a],[b]) => a.localeCompare(b));
  if (!entries.length) throw new Error("DCFR range map is empty");
  return entries.map(([hand, weight]) => {
    const w = Number(weight);
    if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error("DCFR range weight must be between 0 and 1");
    return hand + ":" + w.toFixed(8).replace(/0+$/,"").replace(/\.$/,"");
  }).join(",");
}

function dcfrBoardCards(board, street) {
  const cards = Array.isArray(board)
    ? board.map(card => String(card))
    : String(board || "").match(/[2-9TJQKA][cdhs]/gi) || [];
  const required = { FLOP:3, TURN:4, RIVER:5 }[street];
  if (!required || cards.length !== required) throw new Error(`DCFR ${street} requires exactly ${required || 0} board cards`);
  return cards;
}

export function dcfrScenarioFromMatchup(matchup, {
  board,
  street = "FLOP",
  heroPosition,
  gameType = "CASH",
  actionHistory = [],
  sizings = [33,67,125],
} = {}) {
  if (!matchup || typeof matchup !== "object") throw new Error("DCFR matchup required");
  if (!matchup.opener?.position || !matchup.caller?.position) throw new Error("DCFR matchup positions required");
  if (!Number.isFinite(Number(matchup.pot_chips)) || !Number.isFinite(Number(matchup.eff_stack_chips))) {
    throw new Error("DCFR matchup pot/stack required");
  }
  if (!Array.isArray(actionHistory) || actionHistory.length) {
    throw new Error("DCFR matchup postflop promotion currently supports root decisions only");
  }
  const positions = [matchup.opener.position, matchup.caller.position];
  if (!positions.includes(heroPosition)) throw new Error("heroPosition must be one side of the DCFR matchup");
  const villainPosition = positions.find(position => position !== heroPosition);
  const roles = dcfrPostflopRoles(heroPosition, villainPosition);
  if (heroPosition !== roles.oopPosition) {
    throw new Error("DCFR root training spot requires Hero to be OOP; IP child-node mapping is not wired yet");
  }
  const heroSide = matchup.opener.position === heroPosition ? matchup.opener : matchup.caller;
  const villainSide = matchup.opener.position === villainPosition ? matchup.opener : matchup.caller;
  const chipScale = DCFR_PREFLOP_PROFILE.chipScale;
  return {
    gameType,
    street,
    tableSize: DCFR_PREFLOP_PROFILE.tableSize,
    heroPosition,
    villainPosition,
    effectiveStack: Number(matchup.eff_stack_chips) / chipScale,
    pot: Number(matchup.pot_chips) / chipScale,
    board: dcfrBoardCards(board, street),
    heroRange: dcfrRangeMapToString(heroSide.range),
    villainRange: dcfrRangeMapToString(villainSide.range),
    actionHistory: [],
    sizings,
    oopPosition: roles.oopPosition,
    ipPosition: roles.ipPosition,
    dcfrChipScale: chipScale,
    dcfrSourceMatchup: matchup.matchup,
  };
}

export async function loadDcfrPreflopArtifacts({
  chartsPath = ".stackup/solves/dcfr-production/charts.json",
  matchupsPath = ".stackup/solves/dcfr-production/matchups.json",
  expectedChartsSha256 = null,
  expectedMatchupsSha256 = null,
} = {}) {
  const [chartsBytes, matchupsBytes] = await Promise.all([readFile(chartsPath), readFile(matchupsPath)]);
  const hashes = {
    chartsSha256: createHash("sha256").update(chartsBytes).digest("hex"),
    matchupsSha256: createHash("sha256").update(matchupsBytes).digest("hex"),
  };
  if (expectedChartsSha256 && hashes.chartsSha256 !== expectedChartsSha256.toLowerCase()) throw new Error("DCFR charts SHA-256 mismatch");
  if (expectedMatchupsSha256 && hashes.matchupsSha256 !== expectedMatchupsSha256.toLowerCase()) throw new Error("DCFR matchups SHA-256 mismatch");
  const charts = JSON.parse(chartsBytes.toString("utf8"));
  const matchups = JSON.parse(matchupsBytes.toString("utf8"));
  if (!Array.isArray(charts) || charts.length !== 5) throw new Error("DCFR preflop export must contain 5 RFI charts");
  if (charts.some(chart => !Array.isArray(chart.hands) || chart.hands.length !== PREFLOP_CLASSES)) {
    throw new Error("DCFR RFI charts must contain all 169 classes");
  }
  if (!Array.isArray(matchups) || matchups.length !== 30) throw new Error("DCFR preflop export must contain 30 matchup ranges");
  for (const matchup of matchups) {
    if (!matchup?.matchup || !matchup?.opener?.position || !matchup?.caller?.position) throw new Error("invalid DCFR matchup export");
    dcfrRangeMapToString(matchup.opener.range);
    dcfrRangeMapToString(matchup.caller.range);
  }
  return {
    profile: DCFR_PREFLOP_PROFILE,
    hashes,
    charts,
    matchups,
  };
}

async function requestJson(fetchImpl, baseUrl, path, { method = "GET", body } = {}) {
  const response = await fetchImpl(baseUrl.replace(/\/$/, "") + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = typeof response.text === "function" ? await response.text() : "";
    throw new Error(`GTOpen ${path} failed (${response.status}): ${detail}`.trim());
  }
  return response.json();
}

export function dcfrCommand(scenario, out) {
  validateScenario(scenario);
  const bin = process.env[CONFIG[SOLVER_IDS.DCFR].env] || CONFIG[SOLVER_IDS.DCFR].defaultBin;
  if (scenario.street === "PRE-FLOP") {
    const blueprint = resolve(process.env.STACKUP_DCFR_BLUEPRINT || ".stackup/blueprints/dcfr-6max.bin");
    return { bin, args:["preflop","--iterations",String(Number(process.env.STACKUP_DCFR_PREFLOP_ITERATIONS || 100000000)),"--output",blueprint], output:blueprint, kind:"blueprint" };
  }
  const roles = scenario.oopPosition && scenario.ipPosition
    ? { oopPosition:scenario.oopPosition, ipPosition:scenario.ipPosition }
    : dcfrPostflopRoles(scenario.heroPosition, scenario.villainPosition);
  const ranges = new Map([
    [scenario.heroPosition, scenario.heroRange],
    [scenario.villainPosition, scenario.villainRange],
  ]);
  if (!ranges.has(roles.oopPosition) || !ranges.has(roles.ipPosition)) throw new Error("DCFR OOP/IP positions must match Hero/Villain");
  const chipScale = Number(scenario.dcfrChipScale ?? 1);
  const solverPot = Number(scenario.pot) * chipScale;
  const solverStack = Number(scenario.effectiveStack) * chipScale;
  if (!Number.isInteger(solverPot) || !Number.isInteger(solverStack) || solverPot <= 0 || solverStack <= 0) {
    throw new Error("DCFR solver pot/stack must resolve to positive integer chip units");
  }
  const args=["solve","--street",scenario.street.toLowerCase(),"--board",(scenario.board||[]).join(""),
    "--oop-range",ranges.get(roles.oopPosition),
    "--ip-range",ranges.get(roles.ipPosition),
    "--pot",String(solverPot),"--stack",String(solverStack),
    "--iterations",String(Number(process.env.STACKUP_DCFR_POSTFLOP_ITERATIONS || 10000)),
    "--format","json","--output",out];
  if (scenario.sizings?.length) args.push("--bet-sizes",scenario.sizings.filter(Number.isFinite).join(","));
  return { bin, args, output:out, kind:"json" };
}

export class SolverGateway {
  constructor({ registry, bank }) { this.registry=registry; this.bank=bank; }
  async solveScenario(scenario) {
    const node=this.bank.upsertScenario(scenario);
    const results=await this.registry.solveWithAll(scenario);
    for (const item of results) if (item.ok) this.bank.attachSolve(scenario,item.result);
    return { node:this.bank.get(node.signature), results };
  }
}

export function createDcfrAdapter({ parsePreflopBlueprint } = {}) {
  return {
    id: SOLVER_IDS.DCFR,
    async solve(scenario) {
      const signature=JSON.stringify(scenario);
      const out=outputPath(signature);
      await mkdir(dirname(out),{recursive:true});
      const cmd=dcfrCommand(scenario,out);
      await mkdir(dirname(cmd.output),{recursive:true});
      await run(cmd.bin,cmd.args);
      if (cmd.kind === "blueprint") {
        if (!parsePreflopBlueprint) throw new Error("DCFR preflop blueprint generated; parser/extractor required for this node");
        return parsePreflopBlueprint(cmd.output,scenario);
      }
      const raw=JSON.parse(await readFile(out,"utf8"));
      return normalizeDcfr(raw,scenario);
    }
  };
}

export function normalizeDcfr(raw, scenario) {
  const nodes = raw.strategy || raw.strategies || [];
  if (!Array.isArray(nodes) || !nodes.length) throw new Error("DCFR JSON contains no strategy array");
  if (scenario.street === "PRE-FLOP") throw new Error("DCFR preflop blueprint/matchup exports are not direct training strategies");
  if (scenario.actionHistory?.length) throw new Error("DCFR postflop child-node actionHistory mapping is not wired yet");
  const root = nodes.find(node => node?.node === "root") || nodes[0];
  if (!root || root.player !== "OOP" || !Array.isArray(root.combos) || !root.combos.length) {
    throw new Error("DCFR root OOP strategy required");
  }
  if (scenario.oopPosition && scenario.heroPosition !== scenario.oopPosition) {
    throw new Error("DCFR root strategy belongs to OOP, not the requested Hero");
  }
  const strategy = root.combos.map(combo => {
    if (!combo?.hand || !Array.isArray(combo.actions) || !combo.actions.length) throw new Error("invalid DCFR combo strategy");
    return {
      hand: combo.hand,
      ev: Number(combo.ev),
      actions: combo.actions.map(action => ({
        action: action.action,
        frequency: Number(action.weight) * 100,
      })),
    };
  });
  const provenance = {
    config: raw.config ?? null,
    iterations: raw.iterations ?? null,
    exploitabilityPct: raw.exploitability_pct ?? null,
    oopEv: raw.oop_ev ?? null,
    ipEv: raw.ip_ev ?? null,
    rootNode: root.node,
    rootPlayer: root.player,
    sourceMatchup: scenario.dcfrSourceMatchup ?? null,
    chipScale: Number(scenario.dcfrChipScale ?? 1),
    conditionalRanges: {
      hero: scenario.heroRange,
      villain: scenario.villainRange,
    },
  };
  return {
    status:"SOLVED",
    solver:SOLVER_IDS.DCFR,
    version:raw.version || "dcfr-cli",
    solveId:raw.solve_id || raw.solveId || createHash("sha256").update(JSON.stringify({provenance,strategy})).digest("hex"),
    exploitability:raw.exploitability_pct ?? raw.exploitability ?? null,
    convergence:{
      iterations:raw.iterations ?? null,
      exploitabilityPct:raw.exploitability_pct ?? null,
    },
    scenario,
    strategy,
    rawProvenance:provenance,
  };
}

export function gtopenClassLabel(index) {
  if (!Number.isInteger(index) || index < 0 || index >= PREFLOP_CLASSES) throw new RangeError("invalid GTOpen preflop class index");
  const row = Math.floor(index / 13);
  const col = index % 13;
  if (row === col) return PREFLOP_RANKS[row] + PREFLOP_RANKS[col];
  if (row > col) return PREFLOP_RANKS[row] + PREFLOP_RANKS[col] + "s";
  return PREFLOP_RANKS[col] + PREFLOP_RANKS[row] + "o";
}

export function gtopenPreflopConfig(scenario) {
  validateScenario(scenario);
  if (scenario.street !== "PRE-FLOP") throw new Error("GTOpen preflop config requires PRE-FLOP");
  const positions = scenario.positions || [scenario.heroPosition, scenario.villainPosition];
  if (!Array.isArray(positions) || positions.length < 2) throw new Error("GTOpen positions required");
  const posts = scenario.posts || (positions.length === 2
    ? [0.5, 1]
    : positions.map(pos => pos === "SB" ? 0.5 : pos === "BB" ? 1 : 0));
  if (posts.length !== positions.length) throw new Error("GTOpen posts must align with positions");
  return {
    positions,
    stack: Number(scenario.effectiveStack),
    posts,
    ante: Number(scenario.ante || 0),
    limp: Boolean(scenario.limp),
    open_raises: scenario.openRaises || [2, 2.5],
    raise_mults: scenario.raiseMultipliers || [2.5, 3],
    max_raises: Number(scenario.maxRaises ?? 2),
    add_allin: scenario.addAllin !== false,
    allin_threshold: Number(scenario.allinThreshold ?? 0.80),
    rake_pct: Number(scenario.rake?.pct ?? scenario.rakePct ?? 0),
    rake_cap: Number(scenario.rake?.cap ?? scenario.rakeCap ?? 0),
    no_flop_no_drop: scenario.noFlopNoDrop !== false,
    realization: scenario.realization || "static",
    call_only_seats: scenario.callOnlySeats || [],
  };
}


function normalizeGTOpenActionKind(value) {
  const token = String(value || "").trim().toLowerCase().replace(/[ _-]+/g, "");
  if (token === "allin" || token === "jam") return "jam";
  if (token === "bet" || token === "raise") return "raise";
  if (["fold", "check", "call"].includes(token)) return token;
  return null;
}

function parseGTOpenHistoryStep(step) {
  if (typeof step === "string") {
    const text = step.trim();
    const match = text.match(/^(?:(?<actor>[A-Za-z0-9+_-]+)\s*[:>-]?\s+)?(?<action>fold|check|call|raise|bet|jam|all[ _-]?in)(?:\s+(?:to\s+)?(?<to>\d+(?:\.\d+)?)(?:\s*bb)?)?$/i);
    if (!match) throw new Error("unsupported GTOpen actionHistory step: " + text);
    return {
      actor: match.groups.actor || null,
      actionText: match.groups.action,
      kind: normalizeGTOpenActionKind(match.groups.action),
      to: match.groups.to === undefined ? null : Number(match.groups.to),
    };
  }
  if (!step || typeof step !== "object") throw new Error("GTOpen actionHistory steps must be strings or objects");
  const actor = step.actorPosition ?? step.actorPos ?? step.position ?? step.actor ?? null;
  const actionText = String(step.action ?? step.type ?? step.kind ?? step.label ?? "").trim();
  const embedded = actionText.match(/^(fold|check|call|raise|bet|jam|all[ _-]?in)(?:\s+(?:to\s+)?(\d+(?:\.\d+)?)(?:\s*bb)?)?$/i);
  const kind = normalizeGTOpenActionKind(embedded?.[1] ?? actionText);
  const rawTo = step.to ?? step.raiseTo ?? step.amount ?? step.size ?? embedded?.[2] ?? null;
  const to = rawTo === null || rawTo === undefined || rawTo === "" ? null : Number(rawTo);
  if (!kind) throw new Error("unsupported GTOpen action kind: " + actionText);
  if (to !== null && !Number.isFinite(to)) throw new Error("GTOpen actionHistory TO amount must be numeric");
  return { actor, actionText, kind, to };
}

export function gtopenHistoryActionIndex(node, step) {
  if (!node || node.kind !== "action" || !Array.isArray(node.actions) || !node.actions.length) {
    throw new Error("GTOpen actionHistory reached a non-action node");
  }
  const wanted = parseGTOpenHistoryStep(step);
  if (wanted.actor && node.actor_pos && String(wanted.actor).toUpperCase() !== String(node.actor_pos).toUpperCase()) {
    throw new Error(`GTOpen actionHistory actor mismatch: expected ${node.actor_pos}, got ${wanted.actor}`);
  }

  const exactLabel = node.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => String(action.label || "").toLowerCase() === wanted.actionText.toLowerCase());
  if (exactLabel.length === 1) return exactLabel[0].index;

  let candidates = node.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => normalizeGTOpenActionKind(action.kind) === wanted.kind);
  if (wanted.to !== null) {
    candidates = candidates.filter(({ action }) => Number.isFinite(Number(action.to)) && Math.abs(Number(action.to) - wanted.to) <= 1e-6);
  }
  if (candidates.length === 1) return candidates[0].index;

  const available = node.actions.map(action => action.label || `${action.kind} ${action.to}`).join(", ");
  if (candidates.length === 0) {
    throw new Error(`GTOpen actionHistory action not legal at ${node.actor_pos || "node"}: ${wanted.actionText}; available: ${available}`);
  }
  throw new Error(`GTOpen actionHistory is ambiguous at ${node.actor_pos || "node"}: ${wanted.actionText}; include the exact TO amount; available: ${available}`);
}

export async function resolveGTOpenPreflopHistory({ fetchImpl, baseUrl, actionHistory = [] }) {
  if (!Array.isArray(actionHistory)) throw new Error("GTOpen actionHistory must be an array");
  const path = [];
  let node = await requestJson(fetchImpl, baseUrl, "/api/preflop/node", { method:"POST", body:{ path } });
  for (const step of actionHistory) {
    const actionIndex = gtopenHistoryActionIndex(node, step);
    path.push(actionIndex);
    node = await requestJson(fetchImpl, baseUrl, "/api/preflop/node", { method:"POST", body:{ path:[...path] } });
  }
  return { path, node };
}

function gtopenConditionalRange(node, position) {
  const seat = Array.isArray(node?.positions) ? node.positions.indexOf(position) : -1;
  if (seat < 0 || !Array.isArray(node?.reaches_all?.[seat]) || node.reaches_all[seat].length !== PREFLOP_CLASSES) return null;
  return node.reaches_all[seat].map((frequency, handIndex) => ({
    hand: gtopenClassLabel(handIndex),
    frequency: Number(frequency) * 100,
  }));
}

function validateGTOpenResolvedNode(node, scenario, path) {
  if (!path.length) return;
  if (node.kind !== "action") throw new Error("GTOpen actionHistory does not end at a decision node");
  if (node.actor_pos !== scenario.heroPosition) {
    throw new Error(`GTOpen resolved actor mismatch: scenario hero is ${scenario.heroPosition}, node actor is ${node.actor_pos || "none"}`);
  }
  if (!Array.isArray(node.history) || node.history.length !== path.length + 1) {
    throw new Error("GTOpen resolved node history does not match requested path");
  }
  for (let i = 0; i < path.length; i += 1) {
    if (node.history[i]?.chosen !== path[i]) throw new Error("GTOpen resolved node returned a different action path");
  }
  if (node.history.at(-1)?.chosen !== null) throw new Error("GTOpen resolved node history is missing the current decision");
  if (!Array.isArray(node.reaches_all) || node.reaches_all.length !== node.positions?.length) {
    throw new Error("GTOpen resolved node is missing conditional ranges");
  }
  const heroRange = gtopenConditionalRange(node, scenario.heroPosition);
  const villainRange = gtopenConditionalRange(node, scenario.villainPosition);
  if (!heroRange || !villainRange) throw new Error("GTOpen resolved node is missing Hero/Villain conditional ranges");
  if (Number.isFinite(Number(node.pot)) && Number.isFinite(Number(scenario.pot)) && Math.abs(Number(node.pot) - Number(scenario.pot)) > 1e-6) {
    throw new Error(`GTOpen resolved pot mismatch: scenario ${scenario.pot}bb, node ${node.pot}bb`);
  }
}

export function normalizeGTOpenPreflop(node, status, scenario, session = null, path = []) {
  validateGTOpenResolvedNode(node, scenario, path);
  if (node?.model_evidence?.kind !== "solver") throw new Error("GTOpen node is not solver-backed");
  if (!node?.publication?.converged) throw new Error("GTOpen preflop node is not converged");
  if (!Array.isArray(node.actions) || !node.actions.length) throw new Error("GTOpen node has no actions");
  if (!Array.isArray(node.strategy) || node.strategy.length !== node.actions.length * PREFLOP_CLASSES) {
    throw new Error("GTOpen strategy must be action-major na x 169");
  }
  const strategy = Array.from({ length: PREFLOP_CLASSES }, (_, handIndex) => ({
    hand: gtopenClassLabel(handIndex),
    actions: node.actions.map((action, actionIndex) => ({
      action: action.label,
      kind: action.kind,
      to: action.to,
      frequency: node.strategy[actionIndex * PREFLOP_CLASSES + handIndex] * 100,
    })),
  }));
  const provenance = {
    positions: node.positions,
    publication: node.publication,
    multiwayEquityModel: status?.multiway_equity_model ?? node.publication?.multiway_model ?? null,
    sessionConfig: session?.config ?? null,
    actions: node.actions,
    strategy: node.strategy,
    path: [...path],
    actorPosition: node.actor_pos ?? null,
    pot: node.pot ?? null,
    history: node.history ?? null,
    conditionalRanges: {
      hero: gtopenConditionalRange(node, scenario.heroPosition),
      villain: gtopenConditionalRange(node, scenario.villainPosition),
    },
  };
  return {
    status: "SOLVED",
    solver: SOLVER_IDS.GTOPEN,
    version: "gtopen-local-api",
    solveId: createHash("sha256").update(JSON.stringify(provenance)).digest("hex"),
    exploitability: null,
    convergence: {
      converged: true,
      iteration: status?.iteration ?? node.publication?.published_iteration ?? null,
      publishedIteration: node.publication?.published_iteration ?? null,
      accuracyIteration: node.publication?.accuracy_iteration ?? null,
      gapTotal: node.publication?.gap_total ?? status?.gap_total ?? null,
      targetGap: node.publication?.target_gap ?? status?.target_gap ?? null,
      stopReason: status?.stop_reason ?? null,
      multiwayEquityModel: status?.multiway_equity_model ?? node.publication?.multiway_model ?? null,
    },
    scenario,
    strategy,
    rawProvenance: {
      modelEvidence: node.model_evidence,
      publication: node.publication,
      actions: node.actions,
      sessionConfig: session?.config ?? null,
      path: [...path],
      actorPosition: node.actor_pos ?? null,
      pot: node.pot ?? null,
      history: node.history ?? null,
      conditionalRanges: provenance.conditionalRanges,
    },
  };
}

export function createGTOpenAdapter({
  baseUrl = process.env[CONFIG[SOLVER_IDS.GTOPEN].env] || CONFIG[SOLVER_IDS.GTOPEN].defaultUrl,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 250,
  maxPolls = 2400,
  iterations = 500,
  checkEvery = 25,
  targetGap = 0.05,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation required");
  return {
    id: SOLVER_IDS.GTOPEN,
    async solve(scenario) {
      validateScenario(scenario);
      if (scenario.street !== "PRE-FLOP") throw new Error("GTOpen postflop adapter is not wired yet");
      const config = gtopenPreflopConfig(scenario);
      await requestJson(fetchImpl, baseUrl, "/api/preflop/estimate", { method:"POST", body:config });
      await requestJson(fetchImpl, baseUrl, "/api/preflop/spot", { method:"POST", body:config });
      await requestJson(fetchImpl, baseUrl, "/api/preflop/solve", {
        method:"POST",
        body:{ iterations, check_every:checkEvery, target_gap:targetGap },
      });
      let status = null;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        status = await requestJson(fetchImpl, baseUrl, "/api/preflop/status");
        if (status.state !== "running") break;
        if (pollIntervalMs > 0) await sleep(pollIntervalMs);
      }
      if (!status || status.state === "running") throw new Error("GTOpen preflop solve timeout");
      if (status.state !== "done" || status.error) throw new Error("GTOpen preflop solve failed: " + (status.error || status.state));
      const { path, node } = await resolveGTOpenPreflopHistory({
        fetchImpl,
        baseUrl,
        actionHistory: scenario.actionHistory,
      });
      const session = await requestJson(fetchImpl, baseUrl, "/api/preflop/session");
      return normalizeGTOpenPreflop(node, status, scenario, session, path);
    },
  };
}

export async function saveSolveManifest(path, payload) {
  await mkdir(dirname(resolve(path)),{recursive:true});
  await writeFile(path, JSON.stringify(payload,null,2), "utf8");
}
