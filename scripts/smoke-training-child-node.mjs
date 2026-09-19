import { createGTOpenAdapter, SolverGateway, saveSolveManifest } from "../app/solverGateway.js";
import { MasterSpotBank, SolverRegistry, SOLVER_IDS, solverBackedTrainingSpot } from "../app/spotEngine.js";

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
  legalActions: ["FOLD", "CALL", "RAISE", "ALL-IN"],
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
if (!trainingSpot) throw new Error("child-node solve was not promoted to a training spot");
if (trainingSpot.actionPath.join(",") !== "2") throw new Error("training spot lost the GTOpen action path");
if (trainingSpot.rangeContext?.hero?.length !== 169 || trainingSpot.rangeContext?.villain?.length !== 169) {
  throw new Error("training spot lost conditional Hero/Villain ranges");
}

const path = ".stackup/solves/stackup-training-child-btn-open-2_5-bb.json";
await saveSolveManifest(path, trainingSpot);

const live = range => range.filter(hand => hand.frequency > 0.0001).length;
console.log(JSON.stringify({
  path,
  bankStatus: node.status,
  solvers: Object.keys(node.solves),
  registryResults: results.map(result => ({solver:result.solver,ok:result.ok,error:result.error || null})),
  trainingSpot: {
    solver: trainingSpot.solver,
    solveId: trainingSpot.solveId,
    actionPath: trainingSpot.actionPath,
    actor: trainingSpot.provenance?.actorPosition,
    pot: trainingSpot.provenance?.pot,
    heroRangeClassesWithReach: live(trainingSpot.rangeContext.hero),
    villainRangeClassesWithReach: live(trainingSpot.rangeContext.villain),
    strategyHands: trainingSpot.strategy.length,
    converged: trainingSpot.convergence?.converged,
    gapTotal: trainingSpot.convergence?.gapTotal,
  },
}, null, 2));
