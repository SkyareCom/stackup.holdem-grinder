import { createGTOpenAdapter, saveSolveManifest } from "../app/solverGateway.js";

const scenario = {
  gameType: "TOURNAMENT",
  street: "PRE-FLOP",
  heroPosition: "BTN",
  villainPosition: "BB",
  effectiveStack: 20,
  pot: 1.5,
  board: [],
  heroRange: "100%",
  villainRange: "100%",
  actionHistory: [],
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
const path = ".stackup/solves/gtopen-adapter-btn-bb-20bb.json";
await saveSolveManifest(path, solve);

console.log(JSON.stringify({
  path,
  solver: solve.solver,
  solveId: solve.solveId,
  hands: solve.strategy.length,
  iteration: solve.convergence.iteration,
  gapTotal: solve.convergence.gapTotal,
  targetGap: solve.convergence.targetGap,
  converged: solve.convergence.converged,
  stopReason: solve.convergence.stopReason,
  multiwayEquityModel: solve.convergence.multiwayEquityModel,
  firstHand: solve.strategy[0],
  lastHand: solve.strategy.at(-1),
}, null, 2));
