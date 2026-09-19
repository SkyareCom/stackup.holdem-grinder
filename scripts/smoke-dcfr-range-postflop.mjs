import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDcfrAdapter,
  dcfrScenarioFromMatchup,
  loadDcfrPreflopArtifacts,
  saveSolveManifest,
  SolverGateway,
} from "../app/solverGateway.js";
import {
  MasterSpotBank,
  SolverRegistry,
  SOLVER_IDS,
  solverBackedTrainingSpot,
} from "../app/spotEngine.js";

const defaultBin = resolve(".stackup/solvers/DCFR-SOLVER/target/release/" + (process.platform === "win32" ? "dcfr-solver.exe" : "dcfr-solver"));
await access(defaultBin);
process.env.STACKUP_DCFR_BIN ||= defaultBin;
process.env.STACKUP_DCFR_POSTFLOP_ITERATIONS ||= "1000";

const artifacts = await loadDcfrPreflopArtifacts();
const matchup = artifacts.matchups.find(item => item.matchup === "BTN vs BB");
if (!matchup) throw new Error("DCFR production artifact is missing BTN vs BB");

const scenario = dcfrScenarioFromMatchup(matchup, {
  board: ["Td","9d","6h"],
  street: "FLOP",
  heroPosition: "BB",
  sizings: [33,67,125],
});

const registry = new SolverRegistry().register(createDcfrAdapter());
const bank = new MasterSpotBank();
const gateway = new SolverGateway({ registry, bank });
const { node, results } = await gateway.solveScenario(scenario);
const trainingSpot = solverBackedTrainingSpot(node, SOLVER_IDS.DCFR);
if (!trainingSpot) throw new Error("DCFR postflop solve was not promoted to MasterSpotBank");
if (trainingSpot.rangeContext?.hero !== scenario.heroRange || trainingSpot.rangeContext?.villain !== scenario.villainRange) {
  throw new Error("DCFR training spot lost the exact Hero/Villain ranges");
}

const path = ".stackup/solves/dcfr-production/stackup-training-btn-vs-bb-Td9d6h.json";
await saveSolveManifest(path, trainingSpot);

console.log(JSON.stringify({
  path,
  sourceHashes: artifacts.hashes,
  sourceMatchup: scenario.dcfrSourceMatchup,
  scenario: {
    hero: scenario.heroPosition,
    villain: scenario.villainPosition,
    oop: scenario.oopPosition,
    ip: scenario.ipPosition,
    potBb: scenario.pot,
    effectiveStackBb: scenario.effectiveStack,
    board: scenario.board.join(""),
  },
  bankStatus: node.status,
  registryResults: results.map(result => ({solver:result.solver,ok:result.ok,error:result.error || null})),
  trainingSpot: {
    solver: trainingSpot.solver,
    solveId: trainingSpot.solveId,
    combos: trainingSpot.strategy.length,
    exploitabilityPct: trainingSpot.exploitability,
    iterations: trainingSpot.convergence?.iterations,
    sourceMatchup: trainingSpot.provenance?.sourceMatchup,
  },
}, null, 2));
