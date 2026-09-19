import test from "node:test";
import assert from "node:assert/strict";
import {
  SOLVER_IDS, SolverRegistry, MasterSpotBank, canonicalScenarioSignature,
  solverBackedTrainingSpot, createProcessAdapter
} from "../app/spotEngine.js";

const scenario = {
  gameType:"TOURNAMENT", street:"PRE-FLOP", tableSize:6,
  heroPosition:"BTN", villainPosition:"BB", effectiveStack:25, pot:1.5,
  heroRange:"22+,A2s+,K5s+,Q8s+,J8s+,T8s+,98s,87s,A8o+,KTo+,QTo+,JTo",
  villainRange:"22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,87s,A2o+,K8o+,Q9o+,J9o+,T9o",
  actionHistory:[], legalActions:["FOLD","RAISE"], sizings:[2.2,"ALL-IN"]
};
const solved = {
  status:"SOLVED", solver:SOLVER_IDS.DCFR, version:"test",
  strategy:[
    {hand:"AA",actions:[{action:"RAISE",frequency:100}]},
    {hand:"72o",actions:[{action:"FOLD",frequency:100}]}
  ],
  exploitability:0.01
};

test("assinatura canônica não depende da ordem das chaves", () => {
  const reordered = Object.fromEntries(Object.entries(scenario).reverse());
  assert.equal(canonicalScenarioSignature(scenario), canonicalScenarioSignature(reordered));
});

test("banco não transforma cenário sem solve em spot de treino", () => {
  const bank = new MasterSpotBank();
  const node = bank.upsertScenario(scenario);
  assert.equal(node.status, "PENDING_SOLVE");
  assert.equal(solverBackedTrainingSpot(node), null);
});

test("solve validado promove nó e preserva proveniência", () => {
  const bank = new MasterSpotBank();
  const node = bank.attachSolve(scenario, solved);
  const spot = solverBackedTrainingSpot(node);
  assert.equal(node.status, "SOLVED");
  assert.equal(spot.solver, SOLVER_IDS.DCFR);
  assert.equal(spot.strategy[0].actions[0].frequency, 100);
});

test("spot de treino expõe path e ranges condicionais reais do solver", () => {
  const range169 = Array.from({length:169},(_,i)=>({hand:`H${i}`,frequency:i===0?50:100}));
  const result = {
    ...solved,
    solver: SOLVER_IDS.GTOPEN,
    solveId: "gtopen-child-test",
    rawProvenance: {
      path: [2],
      actorPosition: "BB",
      conditionalRanges: {
        hero: range169,
        villain: range169.map(hand=>({...hand})),
      },
    },
  };
  const bank = new MasterSpotBank();
  const node = bank.attachSolve(scenario, result);
  const spot = solverBackedTrainingSpot(node, SOLVER_IDS.GTOPEN);
  assert.deepEqual(spot.actionPath,[2]);
  assert.equal(spot.rangeContext.hero.length,169);
  assert.equal(spot.rangeContext.villain.length,169);
  assert.equal(spot.rangeContext.hero[0].frequency,50);
  assert.equal(spot.provenance.actorPosition,"BB");
});

test("frequências inválidas são rejeitadas", () => {
  const bank = new MasterSpotBank();
  assert.throws(() => bank.attachSolve(scenario, {
    ...solved, strategy:[{hand:"AA",actions:[{action:"RAISE",frequency:70}]}]
  }), /100/);
});

test("TexasSolver não é aceito como solver pré-flop", () => {
  const bank = new MasterSpotBank();
  assert.throws(() => bank.attachSolve(scenario, {...solved, solver:SOLVER_IDS.TEXAS}), /preflop/);
});

test("registry consulta todos os adapters compatíveis sem inventar fallback", async () => {
  const registry = new SolverRegistry()
    .register(createProcessAdapter({id:SOLVER_IDS.DCFR, invoke:async()=>solved}))
    .register(createProcessAdapter({id:SOLVER_IDS.TEXAS, invoke:async()=>({})}));
  const results = await registry.solveWithAll(scenario);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].solver, SOLVER_IDS.DCFR);
});


test("assinatura distingue contexto e unidades DCFR postflop", () => {
  const postflop = {
    ...scenario,
    street:"FLOP",
    board:["As","7d","2c"],
    oopPosition:"BB",
    ipPosition:"BTN",
    dcfrChipScale:2,
    dcfrSourceMatchup:"BTN vs BB",
  };
  assert.notEqual(canonicalScenarioSignature(postflop),canonicalScenarioSignature({...postflop,dcfrChipScale:1}));
  assert.notEqual(canonicalScenarioSignature(postflop),canonicalScenarioSignature({...postflop,dcfrSourceMatchup:"CO vs BB"}));
  assert.notEqual(canonicalScenarioSignature(postflop),canonicalScenarioSignature({...postflop,oopPosition:"BTN",ipPosition:"BB"}));
});

test("assinatura distingue parâmetros estratégicos do solver pré-flop", () => {
  const base = {...scenario, positions:["BTN","BB"], posts:[0.5,1], openRaises:[2,2.5], raiseMultipliers:[2.5,3], maxRaises:2, addAllin:true, allinThreshold:0.8, realization:"static"};
  assert.notEqual(canonicalScenarioSignature(base), canonicalScenarioSignature({...base, openRaises:[2.2,2.5]}));
  assert.notEqual(canonicalScenarioSignature(base), canonicalScenarioSignature({...base, posts:[1,2]}));
  assert.notEqual(canonicalScenarioSignature(base), canonicalScenarioSignature({...base, realization:"raw"}));
});
