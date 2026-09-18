import test from "node:test";
import assert from "node:assert/strict";
import {
  createGTOpenAdapter,
  dcfrCommand,
  gtopenClassLabel,
  gtopenPreflopConfig,
  normalizeDcfr,
  normalizeGTOpenPreflop,
} from "../app/solverGateway.js";
import { SOLVER_IDS, validateSolverResult } from "../app/spotEngine.js";

const base={gameType:"TOURNAMENT",street:"FLOP",heroPosition:"BB",villainPosition:"BTN",effectiveStack:97,pot:6,board:["As","7d","2c"],heroRange:"22+,A2s+",villainRange:"22+,A2s+",actionHistory:[],sizings:[33,75]};

test("DCFR postflop recebe ranges, board, pot e stack",()=>{
 const c=dcfrCommand(base,"x.json");
 assert.equal(c.args.includes("--oop-range"),true);
 assert.equal(c.args.includes("--ip-range"),true);
 assert.equal(c.args.includes("--board"),true);
 assert.equal(c.args.includes("As7d2c"),true);
});

test("DCFR preflop gera blueprint real e não estratégia sintética",()=>{
 const c=dcfrCommand({...base,street:"PRE-FLOP",board:[]},"x.json");
 assert.equal(c.args[0],"preflop");
 assert.equal(c.kind,"blueprint");
});

test("normalizador rejeita saída sem estratégia",()=>assert.throws(()=>normalizeDcfr({},base),/strategy/));

const preflop={
  gameType:"TOURNAMENT",
  street:"PRE-FLOP",
  heroPosition:"BTN",
  villainPosition:"BB",
  effectiveStack:20,
  pot:1.5,
  board:[],
  heroRange:"100%",
  villainRange:"100%",
  actionHistory:[],
  positions:["BTN","BB"],
  posts:[0.5,1],
  openRaises:[2,2.5],
  raiseMultipliers:[2.5,3],
  maxRaises:2,
  addAllin:true,
  allinThreshold:0.8,
  realization:"static",
};

const actions=[
  {label:"Fold",kind:"fold",to:0},
  {label:"Raise 2",kind:"raise",to:2},
  {label:"Raise 2.5",kind:"raise",to:2.5},
  {label:"All-in 20",kind:"jam",to:20},
];

const solvedNode={
  model_evidence:{kind:"solver",label:"Solver"},
  positions:["BTN","BB"],
  actions,
  strategy:[
    ...Array(169).fill(0.25),
    ...Array(169).fill(0.25),
    ...Array(169).fill(0.25),
    ...Array(169).fill(0.25),
  ],
  publication:{
    multiway_model:"coupled_deck_v1",
    published_iteration:25,
    accuracy_iteration:25,
    gap_total:0.015155669871110432,
    target_gap:0.05,
    converged:true,
  },
};

const solvedStatus={
  state:"done",
  iteration:25,
  gap_total:0.015155669871110432,
  target_gap:0.05,
  stop_reason:"target_reached",
  error:"",
  multiway_equity_model:"coupled_deck_v1",
};

test("GTOpen usa a ordem oficial das 169 classes",()=>{
  assert.equal(gtopenClassLabel(0),"22");
  assert.equal(gtopenClassLabel(1),"32o");
  assert.equal(gtopenClassLabel(13),"32s");
  assert.equal(gtopenClassLabel(168),"AA");
});

test("GTOpen reproduz a configuração BTN x BB 20bb validada",()=>{
  const cfg=gtopenPreflopConfig(preflop);
  assert.deepEqual(cfg.positions,["BTN","BB"]);
  assert.deepEqual(cfg.posts,[0.5,1]);
  assert.equal(cfg.stack,20);
  assert.deepEqual(cfg.open_raises,[2,2.5]);
  assert.deepEqual(cfg.raise_mults,[2.5,3]);
  assert.equal(cfg.realization,"static");
});

test("normalizador GTOpen converte na x 169 para estratégia por mão",()=>{
  const result=normalizeGTOpenPreflop(solvedNode,solvedStatus,preflop,{config:gtopenPreflopConfig(preflop)});
  assert.equal(result.solver,SOLVER_IDS.GTOPEN);
  assert.equal(result.strategy.length,169);
  assert.equal(result.strategy[0].hand,"22");
  assert.equal(result.strategy[168].hand,"AA");
  assert.equal(result.strategy[0].actions.length,4);
  assert.equal(result.strategy[0].actions.reduce((sum,a)=>sum+a.frequency,0),100);
  assert.equal(result.convergence.converged,true);
  assert.equal(result.convergence.gapTotal,0.015155669871110432);
  assert.equal(result.convergence.multiwayEquityModel,"coupled_deck_v1");
  assert.equal(result.solveId.length,64);
  assert.doesNotThrow(()=>validateSolverResult(result,preflop));
});

test("normalizador GTOpen recusa nó não convergido",()=>{
  assert.throws(
    ()=>normalizeGTOpenPreflop({...solvedNode,publication:{...solvedNode.publication,converged:false}},solvedStatus,preflop),
    /not converged/
  );
});

test("adapter GTOpen executa estimate, spot, solve, status, node e session",async()=>{
  const calls=[];
  const payloads={
    "/api/preflop/estimate":{ok:true,nodes:29,action_nodes:10,truncated:false},
    "/api/preflop/spot":{nodes:29,action_nodes:10,multiway_equity_model:"coupled_deck_v1"},
    "/api/preflop/solve":{ok:true},
    "/api/preflop/status":solvedStatus,
    "/api/preflop/node":solvedNode,
    "/api/preflop/session":{config:gtopenPreflopConfig(preflop)},
  };
  const fakeFetch=async(url,options={})=>{
    const path=new URL(url).pathname;
    calls.push({path,options});
    return {
      ok:true,
      status:200,
      async json(){ return payloads[path]; },
      async text(){ return ""; },
    };
  };
  const adapter=createGTOpenAdapter({fetchImpl:fakeFetch,pollIntervalMs:0,maxPolls:2});
  const result=await adapter.solve(preflop);
  assert.equal(result.status,"SOLVED");
  assert.equal(result.solver,SOLVER_IDS.GTOPEN);
  assert.deepEqual(calls.map(c=>c.path),[
    "/api/preflop/estimate",
    "/api/preflop/spot",
    "/api/preflop/solve",
    "/api/preflop/status",
    "/api/preflop/node",
    "/api/preflop/session",
  ]);
});
