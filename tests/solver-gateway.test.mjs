import test from "node:test";
import assert from "node:assert/strict";
import { dcfrCommand, normalizeDcfr } from "../app/solverGateway.js";

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
