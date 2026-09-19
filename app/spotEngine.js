/**
 * STACKUP EVOLUTION — Solver-backed master spot engine.
 *
 * A spot is training material only after a solver adapter returns a validated
 * range-vs-range strategy. Missing solves stay PENDING; no random/heuristic
 * strategy is manufactured.
 */

export const SOLVER_IDS = Object.freeze({
  DCFR: "DCFR_SOLVER",
  CFR_POKER: "CFR_POKER_SOLVER",
  PREFLOP_RANGE: "PREFLOP_RANGE_SOLVER",
  GTOPEN: "GTOPEN",
  TEXAS: "TEXAS_SOLVER",
});

export const SOLVER_CAPABILITIES = Object.freeze({
  [SOLVER_IDS.DCFR]: { preflop: true, postflop: true, multiwayPreflop: true },
  [SOLVER_IDS.CFR_POKER]: { preflop: true, postflop: true, multiwayPreflop: false },
  [SOLVER_IDS.PREFLOP_RANGE]: { preflop: true, postflop: false, multiwayPreflop: false },
  [SOLVER_IDS.GTOPEN]: { preflop: true, postflop: true, multiwayPreflop: true },
  [SOLVER_IDS.TEXAS]: { preflop: false, postflop: true, multiwayPreflop: false },
});

const REQUIRED_SCENARIO = [
  "gameType", "street", "heroPosition", "villainPosition",
  "effectiveStack", "pot", "heroRange", "villainRange", "actionHistory",
];

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])])
  );
  return value;
};

export function canonicalScenarioSignature(scenario) {
  validateScenario(scenario);
  return JSON.stringify(stable({
    gameType: scenario.gameType,
    street: scenario.street,
    tableSize: scenario.tableSize ?? null,
    heroPosition: scenario.heroPosition,
    villainPosition: scenario.villainPosition,
    effectiveStack: scenario.effectiveStack,
    pot: scenario.pot,
    board: scenario.board ?? [],
    heroRange: scenario.heroRange,
    villainRange: scenario.villainRange,
    actionHistory: scenario.actionHistory,
    legalActions: scenario.legalActions ?? [],
    sizings: scenario.sizings ?? [],
    rake: scenario.rake ?? null,
    ante: scenario.ante ?? null,
    icm: scenario.icm ?? null,
    bounty: scenario.bounty ?? null,
    positions: scenario.positions ?? null,
    posts: scenario.posts ?? null,
    limp: scenario.limp ?? null,
    openRaises: scenario.openRaises ?? null,
    raiseMultipliers: scenario.raiseMultipliers ?? null,
    maxRaises: scenario.maxRaises ?? null,
    addAllin: scenario.addAllin ?? null,
    allinThreshold: scenario.allinThreshold ?? null,
    realization: scenario.realization ?? null,
    callOnlySeats: scenario.callOnlySeats ?? null,
    rakePct: scenario.rakePct ?? null,
    rakeCap: scenario.rakeCap ?? null,
    noFlopNoDrop: scenario.noFlopNoDrop ?? null,
    oopPosition: scenario.oopPosition ?? null,
    ipPosition: scenario.ipPosition ?? null,
    dcfrChipScale: scenario.dcfrChipScale ?? null,
    dcfrSourceMatchup: scenario.dcfrSourceMatchup ?? null,
    raiseSizings: scenario.raiseSizings ?? null,
    allinPotRatio: scenario.allinPotRatio ?? null,
    noDonk: scenario.noDonk ?? null,
    geometric: scenario.geometric ?? null,
  }));
}

export function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object") throw new TypeError("scenario required");
  const missing = REQUIRED_SCENARIO.filter(k => scenario[k] === undefined || scenario[k] === null);
  if (missing.length) throw new Error("incomplete range-vs-range scenario: " + missing.join(", "));
  if (!Array.isArray(scenario.actionHistory)) throw new Error("actionHistory must be an array");
  if (!["PRE-FLOP", "FLOP", "TURN", "RIVER"].includes(scenario.street)) throw new Error("invalid street");
  if (!scenario.heroRange || !scenario.villainRange) throw new Error("both ranges are mandatory");
  return scenario;
}

export function validateSolverResult(result, scenario) {
  if (!result || result.status !== "SOLVED") throw new Error("solver result is not SOLVED");
  if (!SOLVER_CAPABILITIES[result.solver]) throw new Error("unknown solver: " + result.solver);
  if (!result.version && !result.solveId) throw new Error("solver provenance required");
  if (!Array.isArray(result.strategy) || result.strategy.length === 0) throw new Error("strategy required");
  for (const hand of result.strategy) {
    if (!hand.hand || !Array.isArray(hand.actions) || hand.actions.length === 0) throw new Error("invalid hand strategy");
    const total = hand.actions.reduce((sum, a) => sum + Number(a.frequency || 0), 0);
    if (Math.abs(total - 100) > 0.51) throw new Error("action frequencies must total 100");
  }
  if (scenario.street === "PRE-FLOP" && !SOLVER_CAPABILITIES[result.solver].preflop) throw new Error("solver cannot solve preflop");
  if (scenario.street !== "PRE-FLOP" && !SOLVER_CAPABILITIES[result.solver].postflop) throw new Error("solver cannot solve postflop");
  return result;
}

export class SolverRegistry {
  constructor() { this.adapters = new Map(); }
  register(adapter) {
    if (!adapter?.id || !SOLVER_CAPABILITIES[adapter.id] || typeof adapter.solve !== "function") {
      throw new Error("invalid solver adapter");
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }
  availableFor(scenario) {
    validateScenario(scenario);
    const phase = scenario.street === "PRE-FLOP" ? "preflop" : "postflop";
    return [...this.adapters.values()].filter(a =>
      SOLVER_CAPABILITIES[a.id][phase] &&
      (typeof a.supports !== "function" || a.supports(scenario))
    );
  }
  async solveWithAll(scenario) {
    const adapters = this.availableFor(scenario);
    const settled = await Promise.allSettled(adapters.map(async adapter => {
      const result = await adapter.solve(scenario);
      return validateSolverResult(result, scenario);
    }));
    return settled.map((entry, index) => entry.status === "fulfilled"
      ? { ok: true, solver: adapters[index].id, result: entry.value }
      : { ok: false, solver: adapters[index].id, error: String(entry.reason?.message || entry.reason) });
  }
}

export class MasterSpotBank {
  constructor() { this.nodes = new Map(); }
  upsertScenario(scenario) {
    const signature = canonicalScenarioSignature(scenario);
    if (!this.nodes.has(signature)) this.nodes.set(signature, {
      signature, scenario: stable(scenario), solves: {}, status: "PENDING_SOLVE",
    });
    return this.nodes.get(signature);
  }
  attachSolve(scenario, result) {
    validateSolverResult(result, scenario);
    const node = this.upsertScenario(scenario);
    node.solves[result.solver] = stable(result);
    node.status = "SOLVED";
    return node;
  }
  get(signature) { return this.nodes.get(signature) ?? null; }
  list({ street, heroPosition, status } = {}) {
    return [...this.nodes.values()].filter(n =>
      (!street || n.scenario.street === street) &&
      (!heroPosition || n.scenario.heroPosition === heroPosition) &&
      (!status || n.status === status)
    );
  }
}

export function solverBackedTrainingSpot(node, preferredSolver) {
  if (!node || node.status !== "SOLVED") return null;
  const solves = node.solves || {};
  const result = preferredSolver && solves[preferredSolver]
    ? solves[preferredSolver]
    : Object.values(solves)[0];
  if (!result) return null;
  return Object.freeze({
    id: node.signature,
    scenario: node.scenario,
    strategy: result.strategy,
    solver: result.solver,
    solverVersion: result.version ?? null,
    solveId: result.solveId ?? null,
    exploitability: result.exploitability ?? null,
    convergence: result.convergence ?? null,
    actionPath: result.rawProvenance?.path ?? [],
    rangeContext: result.rawProvenance?.conditionalRanges ?? {
      hero: node.scenario.heroRange,
      villain: node.scenario.villainRange,
    },
    provenance: result.rawProvenance ?? null,
  });
}

export function createProcessAdapter({ id, invoke }) {
  if (!SOLVER_CAPABILITIES[id]) throw new Error("unknown solver adapter id");
  if (typeof invoke !== "function") throw new Error("invoke function required");
  return Object.freeze({ id, solve: scenario => invoke(id, stable(validateScenario(scenario))) });
}
