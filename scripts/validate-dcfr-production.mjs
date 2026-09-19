import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const root = ".stackup/solves/dcfr-production";
const paths = {
  blueprint: `${root}/blueprint.bin`,
  charts: `${root}/charts.json`,
  matchups: `${root}/matchups.json`,
  manifest: `${root}/manifest.json`,
};

const [blueprintBytes, chartsBytes, matchupsBytes] = await Promise.all([
  readFile(paths.blueprint),
  readFile(paths.charts),
  readFile(paths.matchups),
]);
const charts = JSON.parse(chartsBytes.toString("utf8"));
const matchups = JSON.parse(matchupsBytes.toString("utf8"));

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(message); };

if (!Array.isArray(charts) || charts.length !== 5) fail(`expected 5 DCFR RFI charts, got ${charts?.length}`);
for (const chart of charts) {
  if (!chart?.spot_name || !Array.isArray(chart.hands) || chart.hands.length !== 169) {
    fail(`invalid chart ${chart?.spot_name || "<unnamed>"}`);
  }
  const labels = new Set(chart.hands.map(hand => hand.hand));
  if (labels.size !== 169) fail(`chart ${chart.spot_name} does not contain 169 unique classes`);
  for (const hand of chart.hands) {
    if (!Array.isArray(hand.actions) || !hand.actions.length) fail(`${chart.spot_name} ${hand.hand} has no actions`);
    const total = hand.actions.reduce((sum, action) => {
      if (typeof action.action !== "string" || !Number.isFinite(action.prob) || action.prob < 0 || action.prob > 1) {
        fail(`invalid action probability in ${chart.spot_name} ${hand.hand}`);
      }
      return sum + action.prob;
    }, 0);
    if (Math.abs(total - 1) > 0.01) fail(`${chart.spot_name} ${hand.hand} probabilities sum to ${total}`);
  }
}

if (!Array.isArray(matchups) || matchups.length !== 30) fail(`expected 30 DCFR matchups, got ${matchups?.length}`);
for (const matchup of matchups) {
  if (!matchup?.matchup || !matchup?.opener?.position || !matchup?.caller?.position) fail("invalid DCFR matchup");
  for (const side of [matchup.opener, matchup.caller]) {
    const entries = Object.entries(side.range || {});
    if (!entries.length) fail(`${matchup.matchup} ${side.position} has empty range`);
    for (const [hand, frequency] of entries) {
      if (!hand || !Number.isFinite(frequency) || frequency < 0 || frequency > 1) fail(`invalid range frequency in ${matchup.matchup}`);
    }
  }
}

const manifest = {
  solver: "DCFR_SOLVER",
  source: "exinori/DCFR-SOLVER",
  mode: "preflop MCCFR 6-max NL500 defaults",
  iterations: 10_000_000,
  seed: 42,
  assumptions: {
    stackBB: 100,
    openBB: 2.5,
    sbOpenBB: 3.5,
    threeBetBB: 9,
    fourBetBB: 22,
    sbLimp: true,
    oopPotTaxPct: 20,
  },
  artifacts: {
    blueprint: { path: paths.blueprint, bytes: blueprintBytes.length, sha256: sha256(blueprintBytes) },
    charts: { path: paths.charts, bytes: chartsBytes.length, sha256: sha256(chartsBytes), count: charts.length, handsPerChart: 169 },
    matchups: { path: paths.matchups, bytes: matchupsBytes.length, sha256: sha256(matchupsBytes), count: matchups.length },
  },
  chartNames: charts.map(chart => chart.spot_name),
  matchupNames: matchups.map(matchup => matchup.matchup),
};

await mkdir(dirname(paths.manifest), { recursive: true });
await writeFile(paths.manifest, JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify(manifest, null, 2));
