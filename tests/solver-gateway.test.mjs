import test from "node:test";
import assert from "node:assert/strict";
import {
  createDcfrAdapter,
  createGTOpenAdapter,
  dcfrCommand,
  dcfrRangeMapToString,
  dcfrScenarioFromMatchup,
  gtopenClassLabel,
  gtopenHistoryActionIndex,
  gtopenPreflopConfig,
  normalizeDcfr,
  normalizeGTOpenPreflop,
} from "../app/solverGateway.js";
import { SOLVER_IDS, SolverRegistry, validateSolverResult } from "../app/spotEngine.js";

const base={gameType:"TOURNAMENT",street:"FLOP",heroPosition:"BB",villainPosition:"BTN",effectiveStack:97,pot:6,board:["As","7d","2c"],heroRange:"22+,A2s+",villainRange:"22+,A2s+",actionHistory:[],sizings:[33,75]};

test("DCFR postflop recebe ranges, board, pot e stack",()=>{
 const c=dcfrCommand(base,"x.json");
 assert.equal(c.args.includes("--oop-range"),true);
 assert.equal(c.args.includes("--ip-range"),true);
 assert.equal(c.args.includes("--board"),true);
 assert.equal(c.args.includes("As7d2c"),true);
});

test("DCFR converte matchup pré-flop em cenário postflop Range x Range sem inventar estratégia",()=>{
 const matchup={
   matchup:"BTN vs BB",
   pot_chips:13,
   eff_stack_chips:195,
   opener:{position:"BTN",range:{AA:1,AKs:0.75,"72o":0}},
   caller:{position:"BB",range:{AA:0.5,AKs:1,"72o":0.1}},
 };
 const scenario=dcfrScenarioFromMatchup(matchup,{board:["As","7d","2c"],heroPosition:"BB"});
 assert.equal(scenario.heroPosition,"BB");
 assert.equal(scenario.villainPosition,"BTN");
 assert.equal(scenario.oopPosition,"BB");
 assert.equal(scenario.ipPosition,"BTN");
 assert.equal(scenario.pot,6.5);
 assert.equal(scenario.effectiveStack,97.5);
 assert.equal(scenario.dcfrChipScale,2);
 assert.equal(scenario.dcfrSourceMatchup,"BTN vs BB");
 assert.match(scenario.heroRange,/AA:0.5/);
 assert.match(scenario.villainRange,/AKs:0.75/);
 const command=dcfrCommand(scenario,"x.json");
 assert.equal(command.args[command.args.indexOf("--pot")+1],"13");
 assert.equal(command.args[command.args.indexOf("--stack")+1],"195");
 assert.equal(command.args[command.args.indexOf("--oop-range")+1],scenario.heroRange);
 assert.equal(command.args[command.args.indexOf("--ip-range")+1],scenario.villainRange);
});

test("DCFR range map preserva pesos reais e rejeita pesos inválidos",()=>{
 assert.equal(dcfrRangeMapToString({AA:1,AKs:0.375,"72o":0}),"AA:1,AKs:0.375");
 assert.throws(()=>dcfrRangeMapToString({AA:1.1}),/between 0 and 1/);
});

test("normalizador DCFR promove somente a estratégia root OOP real",()=>{
 const scenario={
   ...base,
   oopPosition:"BB",
   ipPosition:"BTN",
   dcfrChipScale:2,
   dcfrSourceMatchup:"BTN vs BB",
 };
 const raw={
   config:{board:"As7d2c",pot:12,stacks:[194,194],street:"flop"},
   iterations:10000,
   exploitability_pct:0.016,
   oop_ev:-0.2,
   ip_ev:0.3,
   strategy:[
     {node:"root",player:"OOP",combos:[
       {hand:"AhKh",ev:0.2,actions:[{action:"check",weight:0.6},{action:"bet 67%",weight:0.4}]},
       {hand:"AcKc",ev:0.1,actions:[{action:"check",weight:1},{action:"bet 67%",weight:0}]},
     ]},
   ],
 };
 const result=normalizeDcfr(raw,scenario);
 assert.equal(result.solver,SOLVER_IDS.DCFR);
 assert.equal(result.strategy.length,2);
 assert.equal(result.strategy[0].actions[0].frequency,60);
 assert.equal(result.strategy[0].actions[1].frequency,40);
 assert.equal(result.rawProvenance.sourceMatchup,"BTN vs BB");
 assert.equal(result.rawProvenance.conditionalRanges.hero,scenario.heroRange);
 assert.equal(result.solveId.length,64);
 assert.doesNotThrow(()=>validateSolverResult(result,scenario));
});

test("DCFR não promove matchups/ranges como se fossem estratégia",()=>{
 assert.throws(()=>normalizeDcfr({strategy:[{matchup:"BTN vs BB"}]},{...base,street:"PRE-FLOP",board:[]}),/not direct training strategies/);
});

test("registry não agenda fases que o adapter ainda não implementa",()=>{
 const registry=new SolverRegistry()
   .register(createDcfrAdapter())
   .register(createGTOpenAdapter({fetchImpl:async()=>{throw new Error("not called");}}));
 assert.deepEqual(registry.availableFor({...base,street:"PRE-FLOP",board:[]}).map(adapter=>adapter.id),[SOLVER_IDS.GTOPEN]);
 assert.deepEqual(registry.availableFor(base).map(adapter=>adapter.id),[SOLVER_IDS.DCFR]);
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

test("GTOpen actionHistory resolve ação exata e rejeita raise ambíguo",()=>{
  const root={
    kind:"action",
    actor_pos:"BTN",
    actions,
  };
  assert.equal(gtopenHistoryActionIndex(root,{actorPosition:"BTN",action:"RAISE",to:2.5}),2);
  assert.equal(gtopenHistoryActionIndex(root,"BTN RAISE 2.5"),2);
  assert.throws(()=>gtopenHistoryActionIndex(root,{action:"RAISE"}),/ambiguous/);
  assert.throws(()=>gtopenHistoryActionIndex(root,{actorPosition:"BB",action:"RAISE",to:2.5}),/actor mismatch/);
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

test("adapter GTOpen percorre actionHistory até o child node e preserva ranges condicionais",async()=>{
  const calls=[];
  const rootNode={
    ...solvedNode,
    kind:"action",
    actor:0,
    actor_pos:"BTN",
    pot:1.5,
    invested:[0.5,1],
    live:[true,true],
    history:[{kind:"action",actor_pos:"BTN",pot:1.5,actions,chosen:null}],
    reaches_all:[Array(169).fill(1),Array(169).fill(1)],
  };
  const bbActions=[
    {label:"Fold",kind:"fold",to:2.5},
    {label:"Call 2.5",kind:"call",to:2.5},
    {label:"Raise 7.5",kind:"raise",to:7.5},
    {label:"All-in 20",kind:"jam",to:20},
  ];
  const childNode={
    ...solvedNode,
    kind:"action",
    actor:1,
    actor_pos:"BB",
    pot:3.5,
    invested:[2.5,1],
    live:[true,true],
    actions:bbActions,
    strategy:[
      ...Array(169).fill(0.25),
      ...Array(169).fill(0.25),
      ...Array(169).fill(0.25),
      ...Array(169).fill(0.25),
    ],
    history:[
      {kind:"action",actor_pos:"BTN",pot:1.5,actions,chosen:2},
      {kind:"action",actor_pos:"BB",pot:3.5,actions:bbActions,chosen:null},
    ],
    reaches_all:[Array(169).fill(0.5),Array(169).fill(1)],
  };
  const scenario={
    ...preflop,
    heroPosition:"BB",
    villainPosition:"BTN",
    pot:3.5,
    actionHistory:[{actorPosition:"BTN",action:"RAISE",to:2.5}],
  };
  const fakeFetch=async(url,options={})=>{
    const apiPath=new URL(url).pathname;
    const body=options.body ? JSON.parse(options.body) : null;
    calls.push({path:apiPath,body});
    let payload;
    if (apiPath==="/api/preflop/estimate") payload={ok:true,nodes:29,action_nodes:10,truncated:false};
    else if (apiPath==="/api/preflop/spot") payload={nodes:29,action_nodes:10,multiway_equity_model:"coupled_deck_v1"};
    else if (apiPath==="/api/preflop/solve") payload={ok:true};
    else if (apiPath==="/api/preflop/status") payload=solvedStatus;
    else if (apiPath==="/api/preflop/session") payload={config:gtopenPreflopConfig(scenario)};
    else if (apiPath==="/api/preflop/node") payload=body.path.length===0 ? rootNode : childNode;
    else throw new Error("unexpected path "+apiPath);
    return {ok:true,status:200,async json(){return payload;},async text(){return "";}};
  };
  const adapter=createGTOpenAdapter({fetchImpl:fakeFetch,pollIntervalMs:0,maxPolls:2});
  const result=await adapter.solve(scenario);
  const nodeCalls=calls.filter(call=>call.path==="/api/preflop/node");
  assert.deepEqual(nodeCalls.map(call=>call.body.path),[[],[2]]);
  assert.deepEqual(result.rawProvenance.path,[2]);
  assert.equal(result.rawProvenance.actorPosition,"BB");
  assert.equal(result.rawProvenance.pot,3.5);
  assert.equal(result.rawProvenance.conditionalRanges.hero.length,169);
  assert.equal(result.rawProvenance.conditionalRanges.villain.length,169);
  assert.equal(result.rawProvenance.conditionalRanges.hero[168].hand,"AA");
  assert.equal(result.rawProvenance.conditionalRanges.villain[0].frequency,50);
  assert.doesNotThrow(()=>validateSolverResult(result,scenario));
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
