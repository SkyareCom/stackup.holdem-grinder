import { SOLVER_IDS, solverBackedTrainingSpot } from "./spotEngine.js";

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])])
  );
  return value;
};

const clone = value => stable(value);

function matchesFilter(spot, filters = {}) {
  const scenario = spot.scenario;
  if (filters.gameType && scenario.gameType !== filters.gameType) return false;
  if (filters.street && scenario.street !== filters.street) return false;
  if (filters.heroPosition && scenario.heroPosition !== filters.heroPosition) return false;
  if (filters.villainPosition && scenario.villainPosition !== filters.villainPosition) return false;
  if (filters.effectiveStack !== undefined && scenario.effectiveStack !== filters.effectiveStack) return false;
  if (filters.phase && scenario.phase !== filters.phase) return false;
  if (filters.tableSize && scenario.tableSize !== filters.tableSize) return false;
  if (filters.solver && spot.solver !== filters.solver) return false;
  return true;
}

function strategyForHand(spot, hand) {
  const normalized = String(hand || "").trim().toUpperCase();
  if (!normalized) throw new Error("hand required");
  const entry = spot.strategy.find(item => String(item.hand).toUpperCase() === normalized);
  if (!entry) throw new Error(`hand ${hand} is not present in solved strategy`);
  return entry;
}

function hashText(value) {
  let hash=2166136261;
  for (let i=0;i<value.length;i+=1) {
    hash^=value.charCodeAt(i);
    hash=Math.imul(hash,16777619);
  }
  return hash>>>0;
}

function deterministicSequence(ids, seed = "STACKUP") {
  return [...ids].sort((a,b) => {
    const ah=hashText(String(seed)+"|"+a);
    const bh=hashText(String(seed)+"|"+b);
    return ah-bh || a.localeCompare(b);
  });
}

export class SolverBackedTrainingEngine {
  constructor({ bank, preferredSolvers = [SOLVER_IDS.GTOPEN, SOLVER_IDS.DCFR] } = {}) {
    if (!bank || typeof bank.list !== "function") throw new Error("MasterSpotBank required");
    this.bank = bank;
    this.preferredSolvers = [...preferredSolvers];
  }

  trainingSpots(filters = {}) {
    return this.bank.list({status:"SOLVED"}).flatMap(node => {
      const solver = filters.solver
        ? filters.solver
        : this.preferredSolvers.find(id => node.solves?.[id]) || Object.keys(node.solves || {})[0];
      const spot = solverBackedTrainingSpot(node, solver);
      return spot && matchesFilter(spot,filters) ? [spot] : [];
    });
  }

  createSession({ filters = {}, target = 100, seed = "STACKUP", sequence = null } = {}) {
    const spots = this.trainingSpots(filters);
    if (!spots.length) throw new Error("no SOLVED solver-backed spots match the training filters");
    const byId = new Map(spots.map(spot => [spot.id,spot]));
    const availableIds = spots.map(spot => spot.id);
    const baseSequence = sequence
      ? sequence.filter(id => byId.has(id))
      : deterministicSequence(availableIds,seed);
    if (!baseSequence.length) throw new Error("saved training sequence has no compatible solved spots");
    const count = Math.max(1,Math.min(Number(target) || baseSequence.length,baseSequence.length));
    return {
      version:1,
      filters:clone(filters),
      sequence:baseSequence.slice(0,count),
      currentIndex:0,
      status:"not_started",
      seed,
    };
  }

  current(session) {
    if (!session?.sequence?.length) return null;
    const id=session.sequence[session.currentIndex];
    const node=this.bank.get(id);
    if (!node || node.status !== "SOLVED") throw new Error("training sequence references a spot that is not SOLVED");
    const preferred = session.filters?.solver || this.preferredSolvers.find(solver => node.solves?.[solver]);
    return solverBackedTrainingSpot(node,preferred);
  }

  legalActions(session,{hand}) {
    const spot=this.current(session);
    if (!spot) return [];
    const strategy=strategyForHand(spot,hand);
    return Object.freeze(strategy.actions.map(item=>Object.freeze({
      action:item.action,
      frequency:Number(item.frequency),
    })));
  }

  answer(session,{hand,action}) {
    const spot=this.current(session);
    if (!spot) throw new Error("training session is complete");
    const strategy=strategyForHand(spot,hand);
    const selected=String(action || "").trim().toLowerCase();
    const matched=strategy.actions.find(item => String(item.action).trim().toLowerCase()===selected);
    return Object.freeze({
      spotId:spot.id,
      hand:strategy.hand,
      selectedAction:action,
      selectedFrequency:matched ? Number(matched.frequency) : 0,
      strategy:clone(strategy.actions),
      solver:spot.solver,
      solveId:spot.solveId,
      convergence:spot.convergence,
      rangeContext:spot.rangeContext,
      provenance:spot.provenance,
    });
  }

  advance(session) {
    if (!session?.sequence?.length) throw new Error("training session required");
    const next=Math.min(session.currentIndex+1,session.sequence.length);
    return {
      ...clone(session),
      currentIndex:next,
      status:next>=session.sequence.length ? "completed" : "in_progress",
    };
  }

  continue(session) {
    if (!session?.sequence?.length) throw new Error("training session required");
    return {...clone(session),status:session.currentIndex>=session.sequence.length ? "completed" : "in_progress"};
  }

  restart(session) {
    if (!session?.sequence?.length) throw new Error("training session required");
    return {...clone(session),currentIndex:0,status:"restarted"};
  }
}
