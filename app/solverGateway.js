import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SOLVER_IDS, validateScenario } from "./spotEngine.js";

const CONFIG = {
  [SOLVER_IDS.DCFR]: {
    env: "STACKUP_DCFR_BIN",
    defaultBin: process.platform === "win32" ? "dcfr-solver.exe" : "dcfr-solver",
  },
  [SOLVER_IDS.GTOPEN]: { env: "STACKUP_GTOPEN_URL", defaultUrl: "http://127.0.0.1:3737" },
  [SOLVER_IDS.TEXAS]: { env: "STACKUP_TEXAS_SOLVER_BIN", defaultBin: process.platform === "win32" ? "console_solver.exe" : "console_solver" },
  [SOLVER_IDS.CFR_POKER]: { env: "STACKUP_CFR_POKER_BIN", defaultBin: "poker_solver" },
  [SOLVER_IDS.PREFLOP_RANGE]: { env: "STACKUP_PREFLOP_SOLVER_BIN", defaultBin: "poker_solver" },
};

const run = (command, args, { cwd, timeoutMs = 15 * 60_000 } = {}) => new Promise((ok, fail) => {
  const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); fail(new Error("solver timeout")); }, timeoutMs);
  child.stdout?.on("data", d => stdout += d);
  child.stderr?.on("data", d => stderr += d);
  child.on("error", e => { clearTimeout(timer); fail(e); });
  child.on("close", code => {
    clearTimeout(timer);
    code === 0 ? ok({ stdout, stderr }) : fail(new Error(command + " exited " + code + ": " + stderr.slice(-2000)));
  });
});

const outputPath = signature => resolve(process.env.STACKUP_SOLVER_OUTPUT_DIR || ".stackup/solves", Buffer.from(signature).toString("base64url").slice(0, 80) + ".json");

export function dcfrCommand(scenario, out) {
  validateScenario(scenario);
  const bin = process.env[CONFIG[SOLVER_IDS.DCFR].env] || CONFIG[SOLVER_IDS.DCFR].defaultBin;
  if (scenario.street === "PRE-FLOP") {
    const blueprint = resolve(process.env.STACKUP_DCFR_BLUEPRINT || ".stackup/blueprints/dcfr-6max.bin");
    return { bin, args:["preflop","--iterations",String(Number(process.env.STACKUP_DCFR_PREFLOP_ITERATIONS || 100000000)),"--output",blueprint], output:blueprint, kind:"blueprint" };
  }
  const args=["solve","--street",scenario.street.toLowerCase(),"--board",(scenario.board||[]).join(""),
    "--oop-range",scenario.heroPosition === "BB" ? scenario.heroRange : scenario.villainRange,
    "--ip-range",scenario.heroPosition === "BB" ? scenario.villainRange : scenario.heroRange,
    "--pot",String(scenario.pot),"--stack",String(scenario.effectiveStack),
    "--iterations",String(Number(process.env.STACKUP_DCFR_POSTFLOP_ITERATIONS || 10000)),
    "--output",out];
  if (scenario.sizings?.length) args.push("--bet-sizes",scenario.sizings.filter(Number.isFinite).join(","));
  return { bin, args, output:out, kind:"json" };
}

export class SolverGateway {
  constructor({ registry, bank }) { this.registry=registry; this.bank=bank; }
  async solveScenario(scenario) {
    const node=this.bank.upsertScenario(scenario);
    const results=await this.registry.solveWithAll(scenario);
    for (const item of results) if (item.ok) this.bank.attachSolve(scenario,item.result);
    return { node:this.bank.get(node.signature), results };
  }
}

export function createDcfrAdapter({ parsePreflopBlueprint } = {}) {
  return {
    id: SOLVER_IDS.DCFR,
    async solve(scenario) {
      const signature=JSON.stringify(scenario);
      const out=outputPath(signature);
      await mkdir(dirname(out),{recursive:true});
      const cmd=dcfrCommand(scenario,out);
      await mkdir(dirname(cmd.output),{recursive:true});
      await run(cmd.bin,cmd.args);
      if (cmd.kind === "blueprint") {
        if (!parsePreflopBlueprint) throw new Error("DCFR preflop blueprint generated; parser/extractor required for this node");
        return parsePreflopBlueprint(cmd.output,scenario);
      }
      const raw=JSON.parse(await readFile(out,"utf8"));
      return normalizeDcfr(raw,scenario);
    }
  };
}

export function normalizeDcfr(raw, scenario) {
  const strategy = raw.strategy || raw.strategies || [];
  if (!Array.isArray(strategy) || !strategy.length) throw new Error("DCFR JSON contains no strategy array");
  return {
    status:"SOLVED", solver:SOLVER_IDS.DCFR,
    version:raw.version || "dcfr-cli", solveId:raw.solve_id || raw.solveId || null,
    exploitability:raw.exploitability ?? null, convergence:raw.convergence ?? null,
    scenario, strategy
  };
}

export async function saveSolveManifest(path, payload) {
  await mkdir(dirname(resolve(path)),{recursive:true});
  await writeFile(path, JSON.stringify(payload,null,2), "utf8");
}
