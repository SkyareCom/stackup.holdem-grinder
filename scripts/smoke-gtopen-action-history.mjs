import { createGTOpenAdapter, saveSolveManifest } from "../app/solverGateway.js";

const scenario = {
  gameType: "TOURNAMENT",
  street: "PRE-FLOP",
  tableSize: 2,
  heroPosition: "BB",
  villainPosition: "BTN",
  effectiveStack: 20,
  pot: 3.5,
  board: [],
  heroRange: "solver-conditioned",
  villainRange: "solver-conditioned",
  actionHistory: [
    { actorPosition: "BTN", action: "RAISE", to: 2.5 },
  ],
  positions: ["BTN", "BB"],
  posts: [0.5, 1],
  openRaises: [2, 2.5],
  raiseMultipliers: [2.5, 3],
  maxRaises: 2,
  addAllin: true,
  allinThreshold: 0.8,
  realization: "static",
};

const adapter = createGTOpenAdapter({
  iterations: 500,
  checkEvery: 25,
  targetGap: 0.05,
});

const solve = await adapter.solve(scenario);
const path = ".stackup/solves/gtopen-action-history-btn-open-2_5-bb.json";
await saveSolveManifest(path, solve);

const heroRange = solve.rawProvenance?.conditionalRanges?.hero || [];
const villainRange = solve.rawProvenance?.conditionalRanges?.villain || [];
const live = range => range.filter(hand => hand.frequency > 0.0001).length;

console.log(JSON.stringify({
  path,
  solver: solve.solver,
  solveId: solve.solveId,
  actionPath: solve.rawProvenance?.path,
  actor: solve.rawProvenance?.actorPosition,
  pot: solve.rawProvenance?.pot,
  history: solve.rawProvenance?.history?.map(step => ({
    actor: step.actor_pos,
    chosen: step.chosen,
    actions: step.actions?.map(action => action.label),
  })),
  conditionalRanges: {
    heroClassesWithReach: live(heroRange),
    villainClassesWithReach: live(villainRange),
  },
  strategyHands: solve.strategy.length,
  converged: solve.convergence?.converged,
  gapTotal: solve.convergence?.gapTotal,
}, null, 2));
