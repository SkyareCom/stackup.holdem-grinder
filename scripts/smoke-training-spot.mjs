import { createGTOpenAdapter, SolverGateway, saveSolveManifest } from "../app/solverGateway.js";
import { MasterSpotBank, SolverRegistry, SOLVER_IDS, solverBackedTrainingSpot } from "../app/spotEngine.js";

const scenario = {
  gameType: "TOURNAMENT",
  street: "PRE-FLOP",
  tableSize: 2,
  heroPosition: "BTN",
  villainPosition: "BB",
  effectiveStack: 20,
  pot: 1.5,
  board: [],
  heroRange: "100%",
  villainRange: "100%",
  actionHistory: [],
  legalActions: ["FOLD", "RAISE", "ALL-IN"],
  positions: ["BTN", "BB"],
  posts: [0.5, 1],
  openRaises: [2, 2.5],
  raiseMultipliers: [2.5, 3],
  maxRaises: 2,
  addAllin: true,
  allinThreshold: 0.8,
  realization: "static",
};

const registry = new SolverRegistry().register(createGTOpenAdapter({
  iterations: 500,
  checkEvery: 25,
  targetGap: 0.05,
}));
const bank = new MasterSpotBank();
const gateway = new SolverGateway({ registry, bank });

const { node, results } = await gateway.solveScenario(scenario);
const trainingSpot = solverBackedTrainingSpot(node, SOLVER_IDS.GTOPEN);
if (!trainingSpot) throw new Error("GTOpen solve was not promoted to a training spot");

const path = ".stackup/solves/stackup-training-spot-btn-bb-20bb.json";
await saveSolveManifest(path, trainingSpot);

console.log(JSON.stringify({
  path,
  bankStatus: node.status,
  solvers: Object.keys(node.solves),
  registryResults: results.map(r => ({solver:r.solver,ok:r.ok,error:r.error || null})),
  trainingSpot: {
    solver: trainingSpot.solver,
    solveId: trainingSpot.solveId,
    hands: trainingSpot.strategy.length,
    iteration: trainingSpot.convergence?.iteration,
    gapTotal: trainingSpot.convergence?.gapTotal,
    converged: trainingSpot.convergence?.converged,
    model: trainingSpot.convergence?.multiwayEquityModel,
    hero: trainingSpot.scenario.heroPosition,
    villain: trainingSpot.scenario.villainPosition,
    stack: trainingSpot.scenario.effectiveStack,
  },
}, null, 2));
