import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DCFR_PREFLOP_PROFILE,
  loadDcfrPreflopArtifacts,
  saveSolveManifest,
} from "../app/solverGateway.js";

const root = resolve(".stackup/solves/dcfr-production");
const blueprint = resolve(root,"blueprint.bin");
const charts = resolve(root,"charts.json");
const matchups = resolve(root,"matchups.json");
const verifyCharts = resolve(root,".verify/charts.json");
const verifyMatchups = resolve(root,".verify/matchups.json");
const binary = resolve(".stackup/solvers/DCFR-SOLVER/target/release/" + (process.platform === "win32" ? "dcfr-solver.exe" : "dcfr-solver"));
await mkdir(dirname(verifyCharts),{recursive:true});

const run = (command,args) => new Promise((ok,fail)=>{
  const child=spawn(command,args,{windowsHide:true,shell:false});
  let stdout="",stderr="";
  child.stdout.on("data",data=>stdout+=data);
  child.stderr.on("data",data=>stderr+=data);
  child.on("error",fail);
  child.on("close",code=>code===0?ok({stdout,stderr}):fail(new Error(stderr || stdout || ("DCFR exited "+code))));
});

const verification = await run(binary,[
  "chart-preflop",
  "--blueprint",blueprint,
  "--output",verifyCharts,
  "--matchup-output",verifyMatchups,
]);
const meta = verification.stdout.match(/(\d+)\s+iterations,\s+(\d+)\s+info sets/i);
if (!meta) throw new Error("could not read iteration/info-set metadata from DCFR blueprint");

const [artifacts,verifyChartsBytes,verifyMatchupsBytes,binaryBytes] = await Promise.all([
  loadDcfrPreflopArtifacts({blueprintPath:blueprint,chartsPath:charts,matchupsPath:matchups}),
  readFile(verifyCharts),
  readFile(verifyMatchups),
  readFile(binary),
]);
const verifyHashes={
  chartsSha256:createHash("sha256").update(verifyChartsBytes).digest("hex"),
  matchupsSha256:createHash("sha256").update(verifyMatchupsBytes).digest("hex"),
};
if (verifyHashes.chartsSha256 !== artifacts.hashes.chartsSha256) throw new Error("charts.json does not match the production blueprint");
if (verifyHashes.matchupsSha256 !== artifacts.hashes.matchupsSha256) throw new Error("matchups.json does not match the production blueprint");

const manifest={
  solver:"DCFR_SOLVER",
  artifactKind:"6max-preflop-blueprint",
  iterations:Number(meta[1]),
  infoSets:Number(meta[2]),
  profile:DCFR_PREFLOP_PROFILE,
  counts:{
    rfiCharts:artifacts.charts.length,
    matchups:artifacts.matchups.length,
    handsPerChart:artifacts.charts[0]?.hands?.length ?? 0,
  },
  hashes:{
    ...artifacts.hashes,
    solverBinarySha256:createHash("sha256").update(binaryBytes).digest("hex"),
  },
  verification:{
    chartPreflopRoundTrip:true,
    chartsMatchBlueprint:true,
    matchupsMatchBlueprint:true,
  },
};

const path=resolve(root,"manifest.json");
await saveSolveManifest(path,manifest);
console.log(JSON.stringify({path,...manifest},null,2));
