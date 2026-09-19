import test from "node:test";
import assert from "node:assert/strict";
import { MasterSpotBank, SOLVER_IDS } from "../app/spotEngine.js";
import { SolverBackedTrainingEngine } from "../app/trainingEngine.js";

const scenario=(street="PRE-FLOP",hero="BB")=>({
  gameType:"TOURNAMENT",street,tableSize:2,heroPosition:hero,villainPosition:"BTN",
  effectiveStack:20,pot:3.5,board:street==="PRE-FLOP"?[]:["As","7d","2c"],
  heroRange:"solver-conditioned",villainRange:"solver-conditioned",
  actionHistory:[{actorPosition:"BTN",action:"RAISE",to:2.5}],
});

const solve=(solver,id)=>({
  status:"SOLVED",solver,solveId:id,version:"test",
  convergence:{converged:true},
  strategy:[
    {hand:"AA",actions:[{action:"CALL",frequency:25},{action:"RAISE",frequency:75}]},
    {hand:"72o",actions:[{action:"FOLD",frequency:100}]},
  ],
  rawProvenance:{
    path:[2],
    conditionalRanges:{hero:[{hand:"AA",frequency:100}],villain:[{hand:"AA",frequency:50}]},
  },
});

test("training engine usa somente nós SOLVED",()=>{
 const bank=new MasterSpotBank();
 bank.upsertScenario(scenario());
 const engine=new SolverBackedTrainingEngine({bank});
 assert.throws(()=>engine.createSession(),/no SOLVED/);
});

test("filtros selecionam spots solver-backed sem fabricar fallback",()=>{
 const bank=new MasterSpotBank();
 bank.attachSolve(scenario(),solve(SOLVER_IDS.GTOPEN,"gto-1"));
 bank.attachSolve(scenario("FLOP"),solve(SOLVER_IDS.DCFR,"dcfr-1"));
 const engine=new SolverBackedTrainingEngine({bank});
 assert.equal(engine.trainingSpots({street:"PRE-FLOP"}).length,1);
 assert.equal(engine.trainingSpots({street:"PRE-FLOP"})[0].solver,SOLVER_IDS.GTOPEN);
 assert.equal(engine.trainingSpots({street:"FLOP"})[0].solver,SOLVER_IDS.DCFR);
});

test("controles de ação vêm exclusivamente da estratégia resolvida da mão",()=>{
 const bank=new MasterSpotBank();
 bank.attachSolve(scenario(),solve(SOLVER_IDS.GTOPEN,"gto-1"));
 const engine=new SolverBackedTrainingEngine({bank});
 const session=engine.createSession({target:1});
 assert.deepEqual(engine.legalActions(session,{hand:"AA"}),[
   {action:"CALL",frequency:25},
   {action:"RAISE",frequency:75},
 ]);
 assert.throws(()=>engine.legalActions(session,{hand:"KK"}),/not present in solved strategy/);
});

test("resposta do treino devolve frequência real da mão e proveniência",()=>{
 const bank=new MasterSpotBank();
 bank.attachSolve(scenario(),solve(SOLVER_IDS.GTOPEN,"gto-1"));
 const engine=new SolverBackedTrainingEngine({bank});
 const session=engine.createSession({target:1});
 const feedback=engine.answer(session,{hand:"AA",action:"RAISE"});
 assert.equal(feedback.selectedFrequency,75);
 assert.equal(feedback.solver,SOLVER_IDS.GTOPEN);
 assert.equal(feedback.solveId,"gto-1");
 assert.equal(feedback.rangeContext.villain[0].frequency,50);
 assert.deepEqual(feedback.strategy,[{action:"CALL",frequency:25},{action:"RAISE",frequency:75}]);
});

test("CONTINUAR preserva sequência e índice; RECOMEÇAR preserva sequência e zera índice",()=>{
 const bank=new MasterSpotBank();
 bank.attachSolve(scenario(),solve(SOLVER_IDS.GTOPEN,"gto-1"));
 bank.attachSolve({...scenario(),pot:4},solve(SOLVER_IDS.GTOPEN,"gto-2"));
 const engine=new SolverBackedTrainingEngine({bank});
 const original=engine.createSession({target:2,seed:"SESSION-1"});
 const progressed=engine.advance(original);
 const continued=engine.continue(progressed);
 assert.deepEqual(continued.sequence,original.sequence);
 assert.equal(continued.currentIndex,1);
 const restarted=engine.restart(continued);
 assert.deepEqual(restarted.sequence,original.sequence);
 assert.equal(restarted.currentIndex,0);
 assert.equal(restarted.status,"restarted");
});

test("sequência salva não aceita spot pendente ou incompatível",()=>{
 const bank=new MasterSpotBank();
 const solvedNode=bank.attachSolve(scenario(),solve(SOLVER_IDS.GTOPEN,"gto-1"));
 const pending=bank.upsertScenario({...scenario(),pot:5});
 const engine=new SolverBackedTrainingEngine({bank});
 const session=engine.createSession({sequence:[pending.signature,solvedNode.signature],target:2});
 assert.deepEqual(session.sequence,[solvedNode.signature]);
});
