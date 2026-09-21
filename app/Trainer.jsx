"use client";

import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  EXPANSION_PRESETS, TRAINING_GROUP_ORDER, buildStrategicExpansionEntries,
  strategicSignature, matchesExpansionPreset, bountyDecisionAdjustment,
} from "./strategicExpansion";
import {
  createTournamentConfig, initTournament, currentFase as tCurrentFase, currentBlinds as tCurrentBlinds,
  advanceHand as tAdvanceHand, buildTournamentReport, formatTournamentReportText,
  recordFinish, summarizeRankingHistogram, totalTournamentsPlayed,
  FIELD_SIZES as TORNEIO_FIELD_SIZES, STARTING_STACKS as TORNEIO_STARTING_STACKS,
  HANDS_PER_LEVEL_OPTIONS as TORNEIO_HANDS_PER_LEVEL_OPTIONS,
} from "./tournamentEngine";
import { initTable as tInitTable, beginTableHand, resumeTableHand, peekHeroPositionForNextHand } from "./tournamentTableEngine";

/* ============================================================
   STACKUP HOLD'EM PRO
   Banco fixo de 500 spots de PRÉ-FLOP para a fase EARLY GAME,
   gerados uma única vez (determinístico) sem repetições, com
   decisões calculadas a partir de tabelas abertas de range de
   abertura/defesa por posição (motor estratégico interno). Demais combinações
   de fase/street usam um gerador genérico baseado em equity
   aproximada (Chen Score / avaliador de mão) + pot odds.
   ============================================================ */

// ---------- Baralho / RNG determinístico ----------
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];
const RED = { "♥": true, "♦": true };

function buildDeck() {
  const d = [];
  for (let v = 2; v <= 14; v++) for (const s of SUITS) d.push({ v, r: RANKS[v - 2], s });
  return d;
}
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Permutação por SESSÃO (Math.random — de propósito não-determinística): muda a cada
// vez que o app é aberto/recarregado, para não repetir sempre a mesma ordem de spots.
// Caminhada com passo coprimo ao tamanho do banco: cobre 100% dos índices sem repetir,
// independente do tamanho de cada banco (que agora varia por street/fase).
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
const MIN_TRAINING_VARIATIONS = 5000;
function sessionIndex(displayIdx, bankLength, sessionStart, sessionStepRaw) {
  if (bankLength <= 1) return 0;
  let step = (sessionStepRaw % (bankLength - 1)) + 1;
  while (gcd(step, bankLength) !== 1) step = (step % (bankLength - 1)) + 1;
  return (((sessionStart + displayIdx * step) % bankLength) + bankLength) % bankLength;
}
// GERAÇÃO DE SPOTS POR IA (opcional, ver buildAiSelectedEntry mais abaixo): quando cfg.forcedEntry
// vem preenchido, a IA já escolheu um registro válido (posição/cenário/bucket/mão — sempre dentro
// das mesmas enumerações legais do banco local, nunca cartas/EV inventados por ela) e ele entra
// aqui no lugar do passo normal de bank[virtualIndex % bank.length]. Tudo depois disso continua
// IDÊNTICO (mesmo seedStr, mesmas tabelas de decisão determinísticas) — a IA nunca decide a ação
// correta, só escolhe QUAL combinação visitar. virtualIndex ainda varia com cfg.spotIndex (via
// hash) pra dar sementes diferentes em tentativas de retry (ver generateSpot) sem precisar do
// passo coprimo, que não faz sentido pra uma entrada avulsa fora do banco.
function selectSessionVariation(bank, cfg) {
  if (cfg.forcedEntry) {
    const virtualIndex = hashStr(`${cfg.forcedEntry.id || "AI-ENTRY"}|${cfg.spotIndex}`) % 1000000;
    return { entry: cfg.forcedEntry, virtualIndex, variationIndex: 0, virtualPoolLength: Math.max(1, bank.length) };
  }
  if (!bank.length) throw new Error("Treino sem estado estratégico compatível.");
  const virtualPoolLength = Math.max(MIN_TRAINING_VARIATIONS, Number(cfg.trainingTarget || 0), bank.length);
  const virtualIndex = sessionIndex(cfg.spotIndex - 1, virtualPoolLength, cfg.sessionStart, cfg.sessionStepRaw);
  return {
    entry: bank[virtualIndex % bank.length],
    virtualIndex,
    variationIndex: Math.floor(virtualIndex / bank.length),
    virtualPoolLength,
  };
}

// ---------- Avaliador de mão (2-7 cartas) ----------
function evalHand(cards) {
  const counts = {}, suitCounts = {}, values = [];
  for (const c of cards) { counts[c.v] = (counts[c.v] || 0) + 1; suitCounts[c.s] = (suitCounts[c.s] || 0) + 1; values.push(c.v); }
  const uniq = [...new Set(values)].sort((a, b) => b - a);
  const flushSuit = Object.keys(suitCounts).find((s) => suitCounts[s] >= 5);
  const isFlush = Boolean(flushSuit);
  let isStraight = false;
  const check = uniq.includes(14) ? [...uniq, 1] : uniq;
  for (let i = 0; i <= check.length - 5; i++) if (check[i] - check[i + 4] === 4) { isStraight = true; break; }
  const groups = Object.entries(counts).map(([v, n]) => ({ v: +v, n })).sort((a, b) => b.n - a.n || b.v - a.v);
  const quads = groups.find((g) => g.n === 4);
  const tripGroups = groups.filter((g) => g.n === 3);
  const trips = tripGroups[0];
  const pairs = groups.filter((g) => g.n === 2);
  let isStraightFlush = false;
  if (flushSuit) {
    const flushValues = [...new Set(cards.filter((c) => c.s === flushSuit).map((c) => c.v))].sort((a, b) => b - a);
    const flushCheck = flushValues.includes(14) ? [...flushValues, 1] : flushValues;
    for (let i = 0; i <= flushCheck.length - 5; i++) {
      if (flushCheck[i] - flushCheck[i + 4] === 4) { isStraightFlush = true; break; }
    }
  }
  let category = 0;
  if (isStraightFlush) category = 8;
  else if (quads) category = 7;
  else if (trips && (pairs.length >= 1 || tripGroups.length >= 2)) category = 6;
  else if (isFlush) category = 5;
  else if (isStraight) category = 4;
  else if (trips) category = 3;
  else if (pairs.length >= 2) category = 2;
  else if (pairs.length === 1) category = 1;
  return { category };
}
const CATEGORY_EQUITY = [16, 38, 60, 75, 82, 88, 93, 97, 99];

// ---------- Avaliador de mão COM desempate (2-7 cartas) ----------
// evalHand() acima só devolve a categoria (0-8), o que é suficiente pros heurísticos antigos,
// mas não basta pra comparar duas mãos de Monte Carlo (ex.: dois "pares" diferentes empatariam
// sempre). evalHandFull() devolve categoria + um vetor de desempate (kickers, em ordem de
// importância) pra permitir comparação correta entre duas mãos de 7 cartas.
function evalHandFull(cards) {
  const counts = {}, suitGroups = {}, values = [];
  for (const c of cards) {
    counts[c.v] = (counts[c.v] || 0) + 1;
    (suitGroups[c.s] = suitGroups[c.s] || []).push(c.v);
    values.push(c.v);
  }
  const uniqDesc = [...new Set(values)].sort((a, b) => b - a);
  let flushSuit = null, flushValuesDesc = null;
  for (const s in suitGroups) {
    if (suitGroups[s].length >= 5) { flushSuit = s; flushValuesDesc = [...new Set(suitGroups[s])].sort((a, b) => b - a); }
  }
  function bestStraightHigh(valuesDesc) {
    const arr = valuesDesc.includes(14) ? [...valuesDesc, 1] : valuesDesc;
    for (let i = 0; i <= arr.length - 5; i++) if (arr[i] - arr[i + 4] === 4) return arr[i];
    return null;
  }
  const straightFlushHigh = flushSuit ? bestStraightHigh(flushValuesDesc) : null;
  const groups = Object.entries(counts).map(([v, n]) => ({ v: +v, n })).sort((a, b) => b.n - a.n || b.v - a.v);
  const quad = groups.find((g) => g.n === 4);
  const tripGroups = groups.filter((g) => g.n === 3);
  const pairGroups = groups.filter((g) => g.n === 2);
  const straightHigh = bestStraightHigh(uniqDesc);

  if (straightFlushHigh) return { category: 8, tiebreak: [straightFlushHigh] };
  if (quad) {
    const kicker = uniqDesc.find((v) => v !== quad.v);
    return { category: 7, tiebreak: [quad.v, kicker] };
  }
  if (tripGroups.length >= 1 && (pairGroups.length >= 1 || tripGroups.length >= 2)) {
    const tripVal = tripGroups[0].v;
    const pairVal = tripGroups.length >= 2 ? tripGroups[1].v : pairGroups[0].v;
    return { category: 6, tiebreak: [tripVal, pairVal] };
  }
  if (flushSuit) return { category: 5, tiebreak: flushValuesDesc.slice(0, 5) };
  if (straightHigh) return { category: 4, tiebreak: [straightHigh] };
  if (tripGroups.length >= 1) {
    const tripVal = tripGroups[0].v;
    const kickers = uniqDesc.filter((v) => v !== tripVal).slice(0, 2);
    return { category: 3, tiebreak: [tripVal, ...kickers] };
  }
  if (pairGroups.length >= 2) {
    const [p1, p2] = pairGroups.slice(0, 2).map((p) => p.v);
    const kicker = uniqDesc.find((v) => v !== p1 && v !== p2);
    return { category: 2, tiebreak: [p1, p2, kicker] };
  }
  if (pairGroups.length === 1) {
    const pv = pairGroups[0].v;
    const kickers = uniqDesc.filter((v) => v !== pv).slice(0, 3);
    return { category: 1, tiebreak: [pv, ...kickers] };
  }
  return { category: 0, tiebreak: uniqDesc.slice(0, 5) };
}
// Compara duas mãos avaliadas por evalHandFull(). Retorna > 0 se `a` vence, < 0 se `b` vence,
// 0 em caso de empate exato (categoria e todos os kickers iguais).
function compareHandRank(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? -1, bv = b.tiebreak[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function chenScore(c1, c2) {
  const pts = (v) => (v >= 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2);
  const hi = Math.max(c1.v, c2.v), lo = Math.min(c1.v, c2.v);
  let score = pts(hi);
  if (c1.v === c2.v) score = Math.max(score * 2, 5);
  if (c1.s === c2.s) score += 2;
  const gap = hi - lo - 1;
  if (c1.v !== c2.v) {
    if (gap === 1) score -= 1;
    else if (gap === 2) score -= 2;
    else if (gap === 3) score -= 4;
    else if (gap >= 4) score -= 5;
    if (gap === 0 && hi < 12) score += 1;
  }
  return Math.max(0, Math.round(score * 10) / 10);
}
function drawBonus(heroCards, board) {
  if (board.length === 0 || board.length >= 5) return 0;
  const all = [...heroCards, ...board];
  const suitCounts = {};
  all.forEach((c) => (suitCounts[c.s] = (suitCounts[c.s] || 0) + 1));
  const flushDraw = Object.values(suitCounts).some((n) => n === 4);
  const vals = [...new Set(all.map((c) => c.v))].sort((a, b) => a - b);
  let oesd = false, gutshot = false;
  for (let i = 0; i < vals.length - 3; i++) {
    const span = vals[i + 3] - vals[i];
    if (span === 3) oesd = true; else if (span === 4) gutshot = true;
  }
  return (flushDraw ? 12 : 0) + (oesd ? 9 : gutshot ? 4 : 0);
}

// ---------- Grade de 169 mãos + ranking percentil ----------
function buildHandTypes() {
  const order = [14,13,12,11,10,9,8,7,6,5,4,3,2];
  const list = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i; j < order.length; j++) {
      const a = order[i], b = order[j];
      if (a === b) list.push({ type: `${RANKS[a-2]}${RANKS[a-2]}`, a, b: a, suited: false, pair: true });
      else {
        list.push({ type: `${RANKS[a-2]}${RANKS[b-2]}s`, a, b, suited: true, pair: false });
        list.push({ type: `${RANKS[a-2]}${RANKS[b-2]}o`, a, b, suited: false, pair: false });
      }
    }
  }
  list.forEach((h) => {
    const c1 = { v: h.a, s: "♠" };
    const c2 = { v: h.b, s: h.pair ? "♥" : h.suited ? "♠" : "♥" };
    h.score = chenScore(c1, c2);
  });
  list.sort((x, y) => y.score - x.score);
  list.forEach((h, idx) => { h.rank = idx + 1; h.percentile = (h.rank / list.length) * 100; });
  return list;
}
const HAND_TYPES = buildHandTypes();
const HAND_TYPE_MAP = {}; HAND_TYPES.forEach((h) => (HAND_TYPE_MAP[h.type] = h));

// ---------- Posições e tabelas abertas de range ----------
const POSITIONS_ORDER = ["UTG","UTG1","MP","MP1","LJ","HJ","CO","BTN","SB","BB"];
const POS_LABELS = ["SB","BB","UTG","UTG1","MP","MP1","LJ","HJ","CO","BTN"]; // ordem visual na mesa
const POSTFLOP_ACTION_ORDER = ["SB","BB","UTG","UTG1","MP","MP1","LJ","HJ","CO","BTN"];
const HERO_SEAT_COLOR = "#3B82F6";
const VILLAIN_SEAT_COLOR = "#EC4899";
const INACTIVE_SEAT_COLOR = "#374151";
// Card único de log de ação (ver actionLogFixedRows/actionLogActiveRow mais abaixo): altura de
// cada linha e quantas ficam visíveis de uma vez antes de precisar rolar. O card em si é
// adaptável — com 2 jogadores de ação ele só ocupa a altura de 2 linhas — e só trava nessa
// altura máxima (rolando o resto) quando o histórico da street passa de ACTION_LOG_VISIBLE_ROWS.
const ACTION_LOG_ROW_HEIGHT = 34;
const ACTION_LOG_VISIBLE_ROWS = 7;
// Espaço entre as linhas de jogadores dentro do card — a altura visível do card (ver o cálculo
// que usa esses dois valores juntos mais abaixo) precisa somar esse gap entre linhas, senão o
// card corta a última linha mesmo dentro do limite de ACTION_LOG_VISIBLE_ROWS.
const ACTION_LOG_ROW_GAP = 5;
const ACTION_SEAT_COLORS = {
  RAISE: "#22C55E",
  "ISO RAISE": "#22C55E",
  BET: "#22C55E",
  RFI: "#22C55E",
  "3-BET": "#EC4899",
  "3BET": "#EC4899",
  "4-BET": "#3B82F6",
  "4BET": "#3B82F6",
  "ALL IN": "#FACC15",
  "ALL-IN": "#FACC15",
  CHECK: "#A855F7",
  CALL: "#22D3EE",
  LIMP: "#22D3EE",
};
function actionSeatColor(action) {
  const normalized = String(action || "").toUpperCase();
  if (ACTION_SEAT_COLORS[normalized]) return ACTION_SEAT_COLORS[normalized];
  if (normalized.includes("ALL") || normalized.includes("SHOVE")) return "#FACC15";
  if (normalized.includes("4-BET") || normalized.includes("5-BET")) return "#3B82F6";
  if (normalized.includes("3-BET")) return "#EC4899";
  if (normalized.includes("CALL") || normalized.includes("LIMP")) return "#22D3EE";
  if (normalized.includes("RAISE") || normalized === "RFI" || normalized.includes("BET")) return "#22C55E";
  if (normalized === "CHECK") return "#A855F7";
  if (normalized === "FOLD") return "#6B7280";
  return VILLAIN_SEAT_COLOR;
}
function seatColor(seat) {
  if (seat.visualColor) return seat.visualColor;
  if (seat.isHero) return HERO_SEAT_COLOR;
  return seat.isInvolved ? VILLAIN_SEAT_COLOR : INACTIVE_SEAT_COLOR;
}

// Divide contribuições acumuladas em main/side pots. Cada camada usa apenas jogadores que
// alcançaram aquele nível; folds continuam financiando o pote, mas perdem a elegibilidade.
// Valores não cobertos por pelo menos outro jogador são devolvidos, nunca viram side pot.
function calculateSidePots(seats, deadMoneyChips = 0) {
  const contributors = (seats || [])
    .map((seat) => ({ ...seat, contribution: Math.max(0, Number(seat.displayBetChips ?? seat.betChips ?? 0)) }))
    .filter((seat) => seat.contribution > 0);
  const levels = [...new Set(contributors.map((seat) => seat.contribution))].sort((a, b) => a - b);
  const pots = [];
  const refunds = [];
  let previousLevel = 0;

  levels.forEach((level) => {
    const funding = contributors.filter((seat) => seat.contribution >= level);
    const layer = (level - previousLevel) * funding.length;
    if (funding.length >= 2 && layer > 0) {
      const eligible = funding
        .filter((seat) => String(seat.displayAction ?? seat.action ?? "").toUpperCase() !== "FOLD")
        .map((seat) => seat.pos);
      pots.push({ amount: layer, eligible });
    } else if (funding.length === 1 && layer > 0) {
      refunds.push({ pos: funding[0].pos, amount: layer });
    }
    previousLevel = level;
  });

  if (pots.length && deadMoneyChips > 0) pots[0].amount += Number(deadMoneyChips);
  else if (!pots.length && deadMoneyChips > 0) pots.push({ amount: Number(deadMoneyChips), eligible: [] });
  return { pots, refunds };
}

// Linha do tempo de apostas: cada item representa uma ação real e o total já colocado
// pelo jogador naquela street. A mesma posição pode aparecer mais de uma vez quando uma
// nova aposta reabre a ação e exige outra volta da mesa.
function buildActionTimeline(spot) {
  const byPos = new Map(spot.seats.map((seat) => [seat.pos, seat]));
  const events = [];
  const add = (pos, action, betBB) => {
    const seat = byPos.get(pos);
    if (!seat || !action) return;
    const forcedBlindBB = spot.street === "PRE-FLOP" ? (pos === "BB" ? 1 : pos === "SB" ? 0.5 : 0) : 0;
    const totalBB = Math.max(forcedBlindBB, Number(betBB ?? seat.betBB ?? 0));
    events.push({ pos, action, betBB: totalBB, betChips: Math.round(totalBB * spot.bb), isHero: !!seat.isHero });
  };

  if (spot.street === "PRE-FLOP") {
    const heroIdx = POSITIONS_ORDER.indexOf(spot.heroPosition);
    const scenario = spot.bankEntry?.scenario;
    if (["COLD_CALL_3BET","COLD_4BET"].includes(spot.bankEntry?.strategicNode)) {
      for (let i = 0; i < heroIdx; i++) {
        const seat = byPos.get(POSITIONS_ORDER[i]);
        if (seat.pos === spot.openerPos) add(seat.pos, "RFI", spot.openRaiseBB);
        else if (seat.pos === spot.threebettorPos) add(seat.pos, "3-BET", spot.threebetBB);
        else add(seat.pos, seat.action === "CALL" ? "COLD CALL 3-BET" : "FOLD", seat.betBB || 0);
      }
      return events;
    }
    if (scenario === "LIMP_RAISE") {
      for (let i = 0; i < heroIdx; i++) {
        const seat = byPos.get(POSITIONS_ORDER[i]);
        add(seat.pos, seat.action || "FOLD", seat.betBB || 0);
      }
      add(spot.heroPosition, "LIMP", 1);
      for (let i = heroIdx + 1; i < POSITIONS_ORDER.length; i++) {
        const seat = byPos.get(POSITIONS_ORDER[i]);
        add(seat.pos, seat.pos === spot.threebettorPos ? "ISO RAISE" : seat.action || "FOLD", seat.betBB || 0);
        if (seat.pos === spot.threebettorPos) break;
      }
      return events;
    }
    if (scenario === "FACING_3BET") {
      const threeIdx = POSITIONS_ORDER.indexOf(spot.threebettorPos);
      let hadLimpBeforeHero = false;
      // Primeira volta: ações iniciais até a abertura do herói.
      for (let i = 0; i < heroIdx; i++) {
        const seat = byPos.get(POSITIONS_ORDER[i]);
        const limped = seat.action === "CALL" || seat.action === "LIMP";
        if (limped) hadLimpBeforeHero = true;
        add(seat.pos, limped ? "LIMP" : "FOLD", limped ? 1 : 0);
      }
      add(spot.heroPosition, spot.bankEntry?.preflopLevel === 4 ? "3-BET" : hadLimpBeforeHero ? "ISO RAISE" : "RFI", spot.heroOpenBB);
      // A ação continua até o 3-bettor e segue pela direita da mesa.
      for (let i = heroIdx + 1; i < POSITIONS_ORDER.length; i++) {
        const seat = byPos.get(POSITIONS_ORDER[i]);
        if (i === threeIdx) add(seat.pos, spot.bankEntry?.preflopLevel === 4 ? "4-BET" : "3-BET", spot.threebetBB);
        else if (seat.action === "CALL") add(seat.pos, i > threeIdx ? "COLD CALL 3-BET" : "CALL RFI", i > threeIdx ? spot.threebetBB : spot.heroOpenBB);
        else add(seat.pos, "FOLD", 0);
      }
      // Nova volta: limpers/participantes anteriores respondem à 3-bet antes do herói.
      for (let i = 0; i < heroIdx; i++) {
        const seat = byPos.get(POSITIONS_ORDER[i]);
        if (seat.action === "CALL") add(seat.pos, "CALL 3-BET", spot.threebetBB);
      }
      return events;
    }

    // RFI, limps e facing raise acontecem numa volta até a decisão do herói.
    let voluntaryMoneyBeforeRaise = false;
    let raiseOccurred = false;
    for (let i = 0; i < heroIdx; i++) {
      const seat = byPos.get(POSITIONS_ORDER[i]);
      let action = seat.action || "FOLD";
      let betBB = seat.betBB || 0;
      if (action === "RAISE") { action = voluntaryMoneyBeforeRaise ? "ISO RAISE" : "RFI"; raiseOccurred = true; }
      else if ((action === "CALL" || action === "LIMP") && !raiseOccurred) { action = "LIMP"; betBB = 1; }
      else if (action === "CALL" && raiseOccurred) action = "CALL RFI";
      add(seat.pos, action, betBB);
      if (["LIMP", "CALL"].includes(action)) voluntaryMoneyBeforeRaise = true;
    }
    return events;
  }

  const participants = new Set([spot.heroPosition, ...(spot.postflopEntry?.villainPositions || [])]);
  const heroIdx = POSTFLOP_ACTION_ORDER.indexOf(spot.heroPosition);
  const villainIdx = POSTFLOP_ACTION_ORDER.indexOf(spot.postflopEntry?.villainPos);
  const addCheck = (index) => {
    const pos = POSTFLOP_ACTION_ORDER[index];
    const isCurrentBettor = spot.facingBet && pos === spot.postflopEntry?.villainPos;
    if (participants.has(pos) && pos !== spot.heroPosition && !isCurrentBettor) add(pos, "CHECK", 0);
  };
  const addResponse = (index) => {
    const pos = POSTFLOP_ACTION_ORDER[index];
    if (participants.has(pos) && pos !== spot.heroPosition && pos !== spot.postflopEntry?.villainPos) add(pos, "CALL", spot.currentBet / spot.bb);
  };

  if (!spot.facingBet) {
    // Sem aposta: somente quem age antes do herói dá check; a sequência para na decisão dele.
    for (let i = 0; i < heroIdx; i++) addCheck(i);
    return events;
  }

  if (villainIdx >= 0 && villainIdx < heroIdx) {
    // Apostador antes do herói: checks anteriores, BET, depois calls até chegar ao herói.
    for (let i = 0; i < villainIdx; i++) addCheck(i);
    add(spot.postflopEntry.villainPos, "BET", spot.currentBet / spot.bb);
    for (let i = villainIdx + 1; i < heroIdx; i++) addResponse(i);
  } else if (villainIdx > heroIdx) {
    // Apostador depois do herói: primeira volta de checks, BET e segunda volta de calls.
    for (let i = 0; i < heroIdx; i++) addCheck(i);
    add(spot.heroPosition, "CHECK", 0);
    for (let i = heroIdx + 1; i < villainIdx; i++) addCheck(i);
    add(spot.postflopEntry.villainPos, "BET", spot.currentBet / spot.bb);
    for (let i = villainIdx + 1; i < POSTFLOP_ACTION_ORDER.length; i++) addResponse(i);
    for (let i = 0; i < heroIdx; i++) addResponse(i);
  }
  return events;
}

// Auditor matemático executado antes de um spot chegar à tela. Ele rejeita sequências com
// check enfrentando aposta, call sem valor a completar, agressão que não aumenta, stacks
// negativos, pote inconsistente ou valor de call diferente do compromisso real do herói.
function validateSpotIntegrity(spot) {
  const errors = [];
  if (!spot || !Array.isArray(spot.seats) || !spot.bb) return ["SPOT_INCOMPLETO"];
  const timeline = buildActionTimeline(spot);
  const committed = new Map();
  let highestBetBB = spot.street === "PRE-FLOP" ? 1 : 0;

  for (const seat of spot.seats) {
    const bet = Math.max(0, Number(seat.betChips || 0));
    const stack = Math.max(0, Number(seat.stackChips || 0));
    if (!Number.isFinite(bet) || !Number.isFinite(stack)) errors.push(`VALOR_INVALIDO_${seat.pos}`);
    if (bet > stack) errors.push(`APOSTA_ACIMA_STACK_${seat.pos}`);
    committed.set(seat.pos, spot.street === "PRE-FLOP" ? (seat.pos === "BB" ? 1 : seat.pos === "SB" ? 0.5 : 0) : 0);
  }

  for (const event of timeline) {
    const action = String(event.action || "").toUpperCase();
    const previous = committed.get(event.pos) || 0;
    const total = Math.max(previous, Number(event.betBB || 0));
    if (action === "CHECK" && highestBetBB > previous + 0.001) errors.push(`CHECK_APOS_APOSTA_${event.pos}`);
    if ((action.startsWith("CALL") || action.startsWith("COLD CALL")) && highestBetBB <= previous + 0.001) errors.push(`CALL_SEM_APOSTA_${event.pos}`);
    if (["BET", "RFI", "RAISE", "ISO RAISE", "3-BET", "4-BET", "5-BET"].includes(action) && total <= highestBetBB + 0.001) {
      errors.push(`AUMENTO_INVALIDO_${event.pos}`);
    }
    if (["BET", "RFI", "RAISE", "ISO RAISE", "3-BET", "4-BET", "5-BET", "ALL IN", "ALL-IN"].includes(action)) highestBetBB = Math.max(highestBetBB, total);
    committed.set(event.pos, total);
  }

  const maxSeatBet = Math.max(0, ...spot.seats.map((seat) => Number(seat.betChips || 0)));
  if (Math.abs(maxSeatBet - Number(spot.currentBet || 0)) > 1) errors.push("CURRENT_BET_DIVERGENTE");
  const heroSeat = spot.seats.find((seat) => seat.isHero);
  const expectedCall = spot.facingBet ? Math.max(0, maxSeatBet - Number(heroSeat?.betChips || 0)) : 0;
  if (Math.abs(expectedCall - Number(spot.callChips || 0)) > 1) errors.push("CALL_DIVERGENTE");
  if (spot.street === "PRE-FLOP") {
    const expectedPot = Number(spot.ante || spot.bb) + spot.seats.reduce((sum, seat) => sum + Number(seat.betChips || 0), 0);
    if (Math.abs(expectedPot - Number(spot.pot || 0)) > 1) errors.push("POTE_DIVERGENTE");
  } else if (Number(spot.pot || 0) + 1 < spot.seats.reduce((sum, seat) => sum + Number(seat.betChips || 0), 0)) {
    errors.push("POTE_MENOR_QUE_APOSTAS");
  }
  return [...new Set(errors)];
}
// Filtro de SIMULAÇÃO por tamanho de mesa: restringe quais posições podem entrar em jogo no
// treino (herói, abridor, 3-bettor, vilão pós-flop) — nunca mais é usado pra decidir quem
// aparece na tela (isso agora é só computeInvolvedPositions, abaixo, e não usa tableSize).
const TABLE_SIZE_POSITIONS = {
  2: new Set(["SB", "BB"]),
  10: new Set(POSITIONS_ORDER),
  9: new Set(POSITIONS_ORDER.filter((p) => p !== "MP1")),
  8: new Set(POSITIONS_ORDER.filter((p) => p !== "UTG1" && p !== "MP1")),
  6: new Set(["MP", "LJ", "CO", "BTN", "SB", "BB"]),
};
function filterBankByTableSize(bank, tableSize) {
  const allowed = TABLE_SIZE_POSITIONS[tableSize];
  if (!allowed) return bank;
  const filtered = bank.filter((e) => {
    if (tableSize === 2 && e.tableStructure !== "HU_2MAX") return false;
    if (tableSize !== 2 && e.tableStructure === "HU_2MAX") return false;
    if (!allowed.has(e.position)) return false;
    if (e.street && e.street !== "PRE-FLOP") return true;
    const heroIdx = POSITIONS_ORDER.indexOf(e.position);
    const beforeCount = POSITIONS_ORDER.slice(0, heroIdx).filter((pos) => allowed.has(pos)).length;
    const afterCount = POSITIONS_ORDER.slice(heroIdx + 1).filter((pos) => allowed.has(pos)).length;
    if (["FACING_RAISE", "FACING_SHOVE"].includes(e.scenario)) return beforeCount >= 1;
    if (e.scenario === "MULTI_SHOVE") return beforeCount >= 2;
    if (["RESHOVE", "SQUEEZE"].includes(e.scenario)) return beforeCount >= 2;
    if (["FACING_3BET", "LIMP_RAISE"].includes(e.scenario)) return afterCount >= 1;
    if (e.scenario === "ISOLATE_LIMPERS") return beforeCount >= 1;
    return true;
  });
  return filtered;
}
// Jogadores "envolvidos na mão" pra exibição: todo mundo que já teve chance de agir antes do
// herói na ordem de ação pré-flop (índice menor em POSITIONS_ORDER), mais os blinds (SB/BB, já
// postados independente da posição do herói) e o vilão real do spot (abridor/3-bettor/vilão
// pós-flop), sempre incluído mesmo que a posição dele caia "depois" do herói nessa ordem. Não
// depende do tamanho de mesa selecionado — varia sozinho de 2 (herói UTG) a 9 (herói SB) só
// pela posição e pela ação do spot.
function computeInvolvedPositions(spot) {
  const involved = new Set();
  // Em RFI, os blinds ainda participam da decisão. Nos demais cenários, somente jogadores
  // realmente ativos (agressor, callers e adversários pós-flop) recebem destaque.
  if (spot.bankEntry && spot.bankEntry.scenario === "RFI") {
    involved.add("SB");
    involved.add("BB");
  }
  if (spot.openerPos) involved.add(spot.openerPos);
  if (spot.threebettorPos) involved.add(spot.threebettorPos);
  if (spot.postflopEntry && spot.postflopEntry.villainPos) involved.add(spot.postflopEntry.villainPos);
  (spot.multiwayPositions || []).forEach((pos) => involved.add(pos));
  if (spot.postflopEntry && spot.postflopEntry.villainPositions) {
    spot.postflopEntry.villainPositions.forEach((pos) => involved.add(pos));
  }
  involved.delete(spot.heroPosition);
  return involved;
}
// Grupos de posição usados nos treinos específicos (defesa/ataque de BB).
const POSITION_GROUPS = { EP: ["UTG","UTG1","MP"], MP_GROUP: ["MP1","LJ","HJ"], LP: ["CO","BTN","SB"] };
// Cor de borda do badge de posição na mesa — puramente visual, não confundir com POSITION_GROUPS
// acima (que agrupa por força estratégica pros presets BB_EP/BB_MP/BB_LP). SB/BB vermelho,
// UTG/UTG1 roxo, MP/MP1 ciano, HJ/LJ amarelo, CO azul, BTN branco.
function positionBadgeColor(pos) {
  if (["SB", "BB"].includes(pos)) return "#EF4444";
  if (["UTG", "UTG1"].includes(pos)) return "#A855F7";
  if (["MP", "MP1"].includes(pos)) return "#22D3EE";
  if (["HJ", "LJ"].includes(pos)) return "#FACC15";
  if (pos === "CO") return "#3B82F6";
  if (pos === "BTN") return "#FFFFFF";
  return null;
}
// Treinos específicos: filtram os bancos já existentes por posição do herói (e, quando aplicável,
// por grupo de posição do abridor) — os bancos abaixo têm reforço de volume nessas combinações
// estreitas pra garantir 1.000+ spots reais, e essas mesmas entradas já entram no pool geral.
const TRAINING_PRESETS = [
  { key: "BB_EP", label: "BB x EP", group: "DEFESA DE BB", heroPositions: ["BB"], scenario: "FACING_RAISE", openerGroup: POSITION_GROUPS.EP, forceStreetPreflop: true },
  { key: "BB_MP", label: "BB x MP", group: "DEFESA DE BB", heroPositions: ["BB"], scenario: "FACING_RAISE", openerGroup: POSITION_GROUPS.MP_GROUP, forceStreetPreflop: true },
  { key: "BB_LP", label: "BB x LP", group: "DEFESA DE BB", heroPositions: ["BB"], scenario: "FACING_RAISE", openerGroup: POSITION_GROUPS.LP, forceStreetPreflop: true },
  // Blind war: mistura SB abrindo (RFI) e BB respondendo a um raise do SB (FACING_RAISE) —
  // as duas pontas da guerra de blinds numa categoria só.
  { key: "BLIND_WAR", label: "BLIND WAR", group: "GUERRA DE BLINDS", heroPositions: null, scenario: null, openerGroup: ["SB"], forceStreetPreflop: true,
    customMatch: (e) => (e.position === "SB" && e.scenario === "RFI") || (e.position === "BB" && e.scenario === "FACING_RAISE") },
  { key: "ATK_BLINDS_CO_BTN", label: "ATAQUE CO/BTN", group: "GUERRA DE BLINDS", heroPositions: ["CO","BTN"], scenario: "RFI", forceStreetPreflop: true },
  // Reação a 3-bet: o herói abriu, o vilão 3-betou, e a decisão vira 4-bet (exploit) / pagar / foldar
  // no pré-flop — e, a partir dele, a continuação (c-bet/barrel ou check-call/check-raise) no
  // FLOP/TURN/RIVER dentro desse mesmo pote de 3-bet (postflopContext filtra o banco pós-flop
  // dedicado, ver buildThreebetPostflopBank). Funciona em qualquer street, inclusive MIXED.
  { key: "REACAO_3BET", label: "RAISE vs 3BET", group: "JOGO DE 3-BET", heroPositions: null, scenario: "FACING_3BET", postflopContext: "3BET_POT" },
  // Flat em posição: pagar um raise estando em posição (CO/BTN), sem 3-betar nem foldar.
  { key: "FLAT_POSICAO", label: "CO/BTN VS RAISE", group: "FLAT EM POSIÇÃO", heroPositions: ["CO","BTN"], scenario: "FACING_RAISE", forceStreetPreflop: true },
  // Estes dois funcionam em qualquer street, inclusive MIXED — o próprio MIXED sorteia entre
  // PRÉ-FLOP/FLOP/TURN/RIVER já filtrados (também reforçadas pra 1.000+ cada), em vez de cair
  // no gerador antigo sem filtro.
  { key: "CO_BTN_PLAY", label: "CO / BTN", group: "JOGANDO DO CO/BTN", heroPositions: ["CO","BTN"], scenario: null },
  { key: "CHIP_UP", label: "CHIP UP", group: "ACUMULANDO FICHAS", heroPositions: null, scenario: "RFI", faseOverride: "EARLY GAME", forceStreetPreflop: true },
  { key: "OPEN_SHOVE", label: "OPEN SHOVE", group: "ALL-IN E STACK CURTO", heroPositions: null, scenario: "OPEN_SHOVE", forceStreetPreflop: true },
  { key: "CALL_SHOVE", label: "CALL DE SHOVE", group: "ALL-IN E STACK CURTO", heroPositions: null, scenario: "FACING_SHOVE", forceStreetPreflop: true },
  { key: "RESHOVE", label: "RESHOVE", group: "ALL-IN E STACK CURTO", heroPositions: null, scenario: "RESHOVE", forceStreetPreflop: true },
  { key: "MULTI_SHOVE", label: "MULTI SHOVE", group: "ALL-IN E STACK CURTO", heroPositions: null, scenario: "MULTI_SHOVE", forceStreetPreflop: true },
  { key: "SQUEEZE", label: "SQUEEZE", group: "MULTIWAY E LIMPERS", heroPositions: null, scenario: "SQUEEZE", forceStreetPreflop: true },
  { key: "ISOLATE", label: "ISO LIMPERS", group: "MULTIWAY E LIMPERS", heroPositions: null, scenario: "ISOLATE_LIMPERS", forceStreetPreflop: true },
  { key: "LIMP_RAISE", label: "LIMP-RAISE", group: "MULTIWAY E LIMPERS", heroPositions: null, scenario: "LIMP_RAISE", forceStreetPreflop: true },
  ...EXPANSION_PRESETS,
];

// Identidade monocromática: todas as famílias usam o mesmo roxo e se distinguem
// somente por dois fundos alternados — 100% transparente e 80% transparente.
const TRAINING_ESPECIFICO_COLOR = "#FACC15"; // amarelo -- mesma cor dos outros painéis de treino
const ORDERED_TRAINING_PRESETS = TRAINING_GROUP_ORDER.flatMap((group) =>
  TRAINING_PRESETS.filter((preset) => preset.group === group)
);

// Calibrado a partir de conhecimento público consolidado sobre ranges pré-flop de torneios:
// abertura 9-max ~100bb com antes: UTG~13%, UTG1~15%, MP~18%, MP1~21%, LJ~25%, HJ~29%, CO~35%, BTN~47%, SB~42%.
const RFI_THRESHOLD = { UTG:13, UTG1:15, MP:18, MP1:21, LJ:25, HJ:29, CO:35, BTN:47, SB:42 };
// Largura aproximada do range de 3-bet de cada posição (% de mãos) — usada pra calibrar quanto
// o herói pode continuar (call/4-bet) contra um 3-bet vindo daquela posição específica.
const THREEBET_WIDTH = { UTG:4, UTG1:5, MP:6, MP1:7, LJ:8, HJ:9, CO:10, BTN:13, SB:11, BB:9 };

function facingRaiseBaseThresholds(heroPos, openerPos) {
  const heroIdx = POSITIONS_ORDER.indexOf(heroPos);
  const openerIdx = POSITIONS_ORDER.indexOf(openerPos);
  const gap = Math.max(1, heroIdx - openerIdx);
  // Corrigido: threshold CAI com o gap (abridor mais cedo = range mais forte = defesa mais apertada),
  // não sobe — calibrado contra defesa real do BB: vs UTG ~11%, vs CO ~22%, vs BTN ~35-38%.
  let callTh = 10 + 55 / (gap + 1);
  let threebetTh = 3 + 18 / (gap + 1);
  if (heroPos === "BB") callTh += 6; // já investiu o blind + fecha a ação, melhores odds
  if (heroPos === "SB") callTh -= 3; // pode ser espremido pelo BB atrás
  callTh = Math.min(55, Math.max(6, callTh));
  threebetTh = Math.min(15, Math.max(3, threebetTh));
  return { callTh, threebetTh };
}
function buildPreflopEvaluationState(spot) {
  return {
    scenario: spot.bankEntry?.scenario || "RFI",
    strategicNode: spot.bankEntry?.strategicNode || null,
    position: spot.heroPosition,
    openerPos: spot.openerPos,
    threebettorPos: spot.threebettorPos,
    participantCount: spot.participantCount || 2,
    preflopLevel: spot.bankEntry?.preflopLevel || 2,
    effectiveStackBB: Math.min(spot.heroStackBB, ...spot.seats.filter((seat) => !seat.isHero && seat.action !== "FOLD").map((seat) => seat.stackBB || spot.heroStackBB)),
    openRaiseBB: spot.openRaiseBB || 0,
    threebetBB: spot.threebetBB || 0,
    potBB: spot.pot / spot.bb,
    callBB: spot.callChips / spot.bb,
    bountyState: spot.bountyState || null,
    tableStructure: spot.bankEntry?.tableStructure || "STANDARD",
    actionHistory: spot.bankEntry?.actionHistory || [],
  };
}

// Ajusta a posição da mão dentro do range conforme sua morfologia. Isso corrige o viés de tratar
// A5s, 44 e KJo como simples pontos de uma fila de Chen: ranges equilibrados preservam bloqueadores, pares
// e mãos suited/conectadas de forma diferente em RFI, 3-bet, shove e multiway.
function rangeMorphologyPercentile(handType, state) {
  const hand = HAND_TYPE_MAP[handType];
  if (!hand) return 100;
  let adjusted = hand.percentile;
  const ace = hand.a === 14;
  const broadwayCount = Number(hand.a >= 10) + Number(hand.b >= 10);
  const gap = hand.pair ? 0 : hand.a - hand.b;
  const multiway = state.participantCount > 2;
  const aggressiveNode = ["FACING_3BET", "SQUEEZE", "LIMP_RAISE"].includes(state.scenario) || state.preflopLevel >= 3;
  const shoveNode = ["OPEN_SHOVE", "FACING_SHOVE", "RESHOVE", "MULTI_SHOVE"].includes(state.scenario) || state.effectiveStackBB <= 15;

  // chenScore() usa "dobra a pontuação, mínimo 5" pra pares — isso força 22/33/44 (que dobrariam
  // pra 2/3/4) a ficarem empatados em 5.0 com 55 (que já dobra pra exatos 5 por conta própria),
  // colapsando os quatro no mesmo percentil bruto (~43-46, pior que várias mãos ofsuit fracas
  // tipo 98o ou K6s). O -2 padrão não compensa esse buraco nem de longe: mesmo com ele, 22-55
  // continuavam foldando em CO (limiar 35) — bug real encontrado a partir de um spot reportado
  // (44 no CO foldando um RFI). -12 pros pares de 5 pra baixo corrige isso mantendo a ordem
  // (22 < 33 < 44 < 55 em força, preservada porque é um ajuste plano) sem deixar 55 ultrapassar
  // 66, que já abre de posições mais cedo por conta própria.
  if (hand.pair) adjusted += shoveNode ? -5 : aggressiveNode ? (hand.a <= 6 ? 4 : -2) : hand.a <= 5 ? -12 : -2;
  if (hand.suited && ace && hand.b <= 5) adjusted += aggressiveNode ? -8 : -3;
  if (hand.suited && gap <= 2 && hand.a <= 11) adjusted += multiway ? 3 : -2;
  if (!hand.suited && broadwayCount === 2) adjusted += multiway ? -3 : aggressiveNode ? 3 : 0;
  if (!hand.suited && gap >= 4 && !ace) adjusted += 5;
  if (multiway && !(hand.pair || ace || broadwayCount === 2)) adjusted += 4 * (state.participantCount - 2);
  return Math.min(100, Math.max(0.5, adjusted));
}

// Motor de ranges por estado. Recebe apenas a situação real da mão e a classe exata de cartas;
// não conhece índice, variante, tamanho nem frequência do banco que sorteou o spot.
function preflopRangeDecision(state, percentile, adj) {
  if (state.tableStructure === "HU_2MAX") {
    const node = state.strategicNode || "HU_RFI";
    const stackPressure = state.effectiveStackBB <= 12 ? 0.78 : state.effectiveStackBB <= 25 ? 0.9 : 1;
    const thresholds = {
      HU_RFI: [82, "RAISE", "FOLD"], HU_LIMP: [92, "CALL", "FOLD"],
      HU_BB_VS_LIMP: [48, "RAISE", "CHECK"], HU_BB_VS_RAISE: [68, "CALL", "FOLD"],
      HU_3BET: [22, "RAISE", "CALL"], HU_FACING_3BET: [36, "CALL", "FOLD"],
      HU_4BET: [11, "RAISE", "FOLD"], HU_PUSH_FOLD: [58, "ALL IN", "FOLD"],
    };
    const [base, inside, outside] = thresholds[node] || thresholds.HU_RFI;
    const threshold = Math.min(95, Math.max(3, base * stackPressure * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj));
    // callLegal deriva das próprias duas opções da tabela (inside/outside) — nunca hardcoded por
    // nó, pra não desalinhar se a tabela mudar. Ex.: HU_RFI é RAISE/FOLD (sem CALL), HU_LIMP é
    // CALL/FOLD (com CALL).
    return { action: percentile <= threshold ? inside : outside, mainThreshold: threshold, threebetThreshold: ["HU_3BET","HU_4BET"].includes(node) ? threshold : null, callLegal: inside === "CALL" || outside === "CALL" };
  }
  if (state.strategicNode === "BB_VS_LIMPERS" || state.strategicNode === "HU_BB_VS_LIMP") {
    const threshold = Math.min(55, Math.max(10, 32 * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj));
    return { action: percentile <= threshold ? "RAISE" : "CHECK", mainThreshold: threshold, threebetThreshold: threshold, callLegal: false };
  }
  if (state.scenario === "OPEN_SHOVE") {
    const base = RFI_THRESHOLD[state.position] || 20;
    const threshold = Math.min(48, Math.max(8, base * 0.72 * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj));
    return { action: percentile <= threshold ? "ALL IN" : "FOLD", mainThreshold: threshold, threebetThreshold: null, callLegal: false };
  }
  if (state.scenario === "FACING_SHOVE") {
    const base = state.position === "BB" ? 24 : state.position === "SB" ? 18 : 12;
    const bountyBoost = state.bountyState?.coversVillain
      ? Math.min(12, (state.bountyState.villainBountyBB || 0) * Math.max(1, state.bountyState.availableBounties || 1) * 0.35)
      : 0;
    const threshold = Math.min(42, Math.max(4, base * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj * 0.5 + bountyBoost));
    return { action: percentile <= threshold ? "CALL" : "FOLD", mainThreshold: threshold, threebetThreshold: null, callLegal: true };
  }
  if (state.scenario === "MULTI_SHOVE") {
    const base = state.position === "BB" ? 18 : state.position === "SB" ? 14 : 10;
    const opponents = Math.max(2, (state.participantCount || 3) - 1);
    const threshold = Math.min(22, Math.max(2.5, base * adj.softFactor * (2 - adj.icmFactor) - (opponents - 2) * 2.5 + adj.mixAdj * 0.35));
    return { action: percentile <= threshold ? "CALL" : "FOLD", mainThreshold: threshold, threebetThreshold: null, callLegal: true };
  }
  if (state.scenario === "RESHOVE") {
    const base = state.position === "BB" || state.position === "SB" ? 17 : 12;
    const threshold = Math.min(24, Math.max(4, base * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj * 0.5));
    return { action: percentile <= threshold ? "ALL IN" : "FOLD", mainThreshold: threshold, threebetThreshold: null, callLegal: false };
  }
  if (state.scenario === "ISOLATE_LIMPERS") {
    const base = (RFI_THRESHOLD[state.position] || 20) * 0.82;
    const threshold = Math.min(48, Math.max(6, base * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj));
    return { action: percentile <= threshold ? "RAISE" : "FOLD", mainThreshold: threshold, threebetThreshold: threshold, callLegal: false };
  }
  if (state.scenario === "SQUEEZE") {
    const { callTh, threebetTh } = facingRaiseBaseThresholds(state.position, state.openerPos);
    const raiseThreshold = Math.max(3, Math.min(12, threebetTh * 0.82 - (adj.icmFactor - 1) * 4));
    const callThreshold = Math.max(raiseThreshold, Math.min(32, callTh * 0.72 * adj.softFactor * (2 - adj.icmFactor)));
    const action = percentile <= raiseThreshold ? "RAISE" : percentile <= callThreshold ? "CALL" : "FOLD";
    return { action, mainThreshold: callThreshold, threebetThreshold: raiseThreshold, callLegal: true };
  }
  if (state.scenario === "LIMP_RAISE") {
    const callThreshold = Math.max(7, 22 * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj * 0.5);
    const raiseThreshold = Math.max(2.5, 7 - (adj.icmFactor - 1) * 3);
    const action = percentile <= raiseThreshold ? "RAISE" : percentile <= callThreshold ? "CALL" : "FOLD";
    return { action, mainThreshold: callThreshold, threebetThreshold: raiseThreshold, callLegal: true };
  }
  if (state.scenario === "RFI") {
    const base = RFI_THRESHOLD[state.position];
    const threshold = Math.min(75, Math.max(4, base * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj));
    return { action: percentile <= threshold ? "RAISE" : "FOLD", mainThreshold: threshold, threebetThreshold: null, callLegal: false };
  }
  if (state.scenario === "FACING_3BET") {
    // A largura do range de 3-bet do vilão depende principalmente da POSIÇÃO DELE. A resposta
    // agressiva do herói permanece concentrada no topo do range, sem usar cartas bloqueadoras
    // isoladas como justificativa para investir mais fichas.
    const width = THREEBET_WIDTH[state.threebettorPos] || 7;
    const multiwayPenalty = Math.max(0, (state.participantCount || 2) - 2) * 2.5;
    const fourbetPenalty = state.preflopLevel === 4 ? 5 : 0;
    const callThreshold = Math.min(24, Math.max(4, width * 1.4 * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj - multiwayPenalty - fourbetPenalty));
    const fourbetThreshold = Math.max(1.5, Math.min(6, width * 0.32) - (adj.icmFactor - 1) * 2 - multiwayPenalty * 0.35 - fourbetPenalty * 0.4);
    let action;
    if (percentile <= fourbetThreshold) action = "RAISE"; // 4-bet
    else if (percentile <= callThreshold) action = "CALL";
    else action = "FOLD";
    return { action, mainThreshold: callThreshold, threebetThreshold: fourbetThreshold, callLegal: true };
  }
  const { callTh, threebetTh } = facingRaiseBaseThresholds(state.position, state.openerPos);
  const multiwayPenalty = Math.max(0, (state.participantCount || 2) - 2) * 3;
  const callThreshold = Math.min(70, Math.max(6, callTh * adj.softFactor * (2 - adj.icmFactor) + adj.mixAdj - multiwayPenalty));
  const threebetThreshold = Math.max(2.5, Math.min(8, threebetTh - (adj.icmFactor - 1) * 5 - multiwayPenalty * 0.35));
  let action;
  if (percentile <= threebetThreshold) action = "RAISE";
  else if (percentile <= callThreshold) action = "CALL";
  else action = "FOLD";
  return { action, mainThreshold: callThreshold, threebetThreshold, callLegal: true };
}

// ---------- Banco fixo de PRÉ-FLOP por fase ----------
// 12 variantes cobrem qualquer treino específico com folga de 2.000+ spots reais mesmo nos casos
// mais estreitos (uma única posição + um único cenário, ex.: BB defendendo contra um raise):
// 169 mãos x 12 variantes = 2.028.
const VARIANT_TAGS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
// Gerador de rótulo de variante SEM TETO — ao contrário de indexar um array fixo (VARIANT_TAGS,
// 12 posições), esta função nunca devolve undefined não importa quantas variantes sejam pedidas.
// BUG CORRIGIDO: o reforço pós-flop (POSTFLOP_BOOST_CONFIG, abaixo) pedia até 24 variantes por
// posição indexando VARIANT_TAGS[vi] direto — a partir de vi=12 isso já devolvia `undefined`,
// criando registros LITERALMENTE idênticos (mesma posição/cenário/bucket/spr/variant) dentro do
// próprio banco. A[índice] em base 26 (A..Z, depois AA..AZ, BA...) resolve isso pra qualquer
// contagem de reforço, agora ou no futuro.
function variantTag(i) {
  let n = Math.max(0, Math.floor(i)), s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
// Combinações (posição+cenário) usadas pelos treinos específicos de blind — reforçadas com
// variantes extras pra garantir 1.000+ spots reais cada, e essas mesmas entradas somam ao
// pool geral (entram na randomização normal também). RFI por posição saiu daqui e virou reforço
// geral (GENERAL_PREFLOP_BOOST_TARGETS, abaixo) — o RFI de UTG/UTG1/MP/MP1/LJ/HJ não tinha
// NENHUM reforço antes (só 169 registros, um por mão), o pior gargalo real de "spots repetindo"
// filtrando por essas posições (RFI tem o maior peso de sorteio no treino geral, 20%).
const PREFLOP_BOOST_TARGETS = [
  { position: "BB", scenario: "FACING_RAISE" }, // defesa de BB (EP/MP/LP) + lado BB do blind war
  { position: "CO", scenario: "FACING_RAISE" },  // flat em posição / remoção de flat
  { position: "BTN", scenario: "FACING_RAISE" }, // flat em posição / remoção de flat
];
// Reforço geral de RFI: TODAS as posições (exceto BB, que nunca dá RFI) ganham a mesma
// quantidade de variantes extras — antes só SB/CO/BTN tinham reforço (via PREFLOP_BOOST_TARGETS)
// e as 6 posições restantes ficavam com só 169 registros (uma mão cada), o mínimo possível.
// 20 variantes x 169 mãos = 3.380 registros de RFI por posição (era 169).
const GENERAL_PREFLOP_BOOST_COUNT = 20;
const GENERAL_PREFLOP_BOOST_TARGETS = POSITIONS_ORDER.filter((pos) => pos !== "BB").map((position) => ({ position, scenario: "RFI" }));
function buildPreflopBank(faseKey) {
  const combos = [];
  for (const pos of POSITIONS_ORDER) {
    if (pos === "BB") continue;
    for (const h of HAND_TYPES) combos.push({ scenario: "RFI", position: pos, handType: h.type, variant: "A" });
  }
  // 6.000 novos spots por cenário e por fase (era 2.000, tentativas anteriores chegaram a
  // 19.500 uniformemente — desperdício de volume nos cenários que posições iniciais nem
  // participam, sem resolver o gargalo real, e deixando a geração lenta demais). Todos entram
  // diretamente no banco mestre; `variant` diferencia repetições da mesma classe de mão/posição
  // sem duplicar IDs.
  const addExactScenario = (scenario, positions, extraForIndex) => {
    for (let n = 0; n < 6000; n++) {
      const position = positions[n % positions.length];
      const handIndex = Math.floor(n / positions.length) % HAND_TYPES.length;
      combos.push({
        scenario,
        position,
        handType: HAND_TYPES[handIndex].type,
        variant: `${scenario}-${String(n + 1).padStart(4, "0")}`,
        ...extraForIndex(n),
      });
    }
  };
  const nonBB = POSITIONS_ORDER.filter((pos) => pos !== "BB");
  const afterFirst = POSITIONS_ORDER.slice(1);
  addExactScenario("OPEN_SHOVE", nonBB, () => ({ participantCount: 2, preflopLevel: 5 }));
  addExactScenario("FACING_SHOVE", afterFirst, () => ({ participantCount: 2, preflopLevel: 5 }));
  addExactScenario("RESHOVE", POSITIONS_ORDER.slice(2), () => ({ participantCount: 3, preflopLevel: 5 }));
  addExactScenario("MULTI_SHOVE", POSITIONS_ORDER.slice(3), (n) => ({ participantCount: n % 2 === 0 ? 3 : 4, preflopLevel: 5 }));
  addExactScenario("SQUEEZE", POSITIONS_ORDER.slice(2), (n) => ({ participantCount: n % 2 === 0 ? 3 : 4, preflopLevel: 3 }));
  addExactScenario("ISOLATE_LIMPERS", nonBB.slice(1), (n) => ({ participantCount: n % 2 === 0 ? 3 : 4, preflopLevel: 2 }));
  addExactScenario("LIMP_RAISE", nonBB, (n) => ({ participantCount: n % 2 === 0 ? 3 : 4, preflopLevel: 3 }));
  // Reforço cirúrgico só pras posições iniciais (UTG/UTG1/MP/MP1/LJ): elas ficam de fora da
  // maioria dos cenários de "reação" acima (FACING_SHOVE, RESHOVE, MULTI_SHOVE, SQUEEZE,
  // FACING_RAISE, FACING_3BET mais abaixo) só por serem as primeiras a agir — sem esse
  // complemento, a densidade delas fica bem menor que as posições tardias mesmo com o mesmo n
  // geral (medição real: UTG caía pra ~1.291 spots quando fase+street+posição eram combinados
  // ao mesmo tempo; ver AGENTS.md). Reaproveita os mesmos dois cenários em que elas já
  // participam (OPEN_SHOVE e LIMP_RAISE), só que distribuído entre menos posições — cada uma
  // recebe mais.
  const earlyPositions = ["UTG", "UTG1", "MP", "MP1", "LJ"];
  for (let n = 0; n < 10000; n++) {
    const position = earlyPositions[n % earlyPositions.length];
    const handIndex = Math.floor(n / earlyPositions.length) % HAND_TYPES.length;
    combos.push({ scenario: "OPEN_SHOVE", position, handType: HAND_TYPES[handIndex].type, variant: `OPEN_SHOVE-EARLY-${String(n + 1).padStart(4, "0")}`, participantCount: 2, preflopLevel: 5 });
    combos.push({ scenario: "LIMP_RAISE", position, handType: HAND_TYPES[handIndex].type, variant: `LIMP_RAISE-EARLY-${String(n + 1).padStart(4, "0")}`, participantCount: n % 2 === 0 ? 3 : 4, preflopLevel: 3 });
  }
  for (let i = 1; i < POSITIONS_ORDER.length; i++) {
    const pos = POSITIONS_ORDER[i];
    for (const h of HAND_TYPES) {
      combos.push({ scenario: "FACING_RAISE", position: pos, handType: h.type, variant: "A", participantCount: 2, preflopLevel: 2 });
      combos.push({ scenario: "FACING_RAISE", position: pos, handType: h.type, variant: "MW3", participantCount: 3, preflopLevel: 2 });
      combos.push({ scenario: "FACING_RAISE", position: pos, handType: h.type, variant: "MW4", participantCount: 4, preflopLevel: 2 });
    }
  }
  // FACING_3BET: o herói abriu e agora enfrenta um 3-bet — decide 4-bet (RAISE) / pagar / foldar.
  // BB nunca é o abridor original (é sempre quem fecha a ação), por isso fica de fora daqui.
  for (const pos of POSITIONS_ORDER) {
    if (pos === "BB") continue;
    for (const h of HAND_TYPES) combos.push({ scenario: "FACING_3BET", position: pos, handType: h.type, variant: "A", participantCount: 2, preflopLevel: 3 });
    for (const h of HAND_TYPES) combos.push({ scenario: "FACING_3BET", position: pos, handType: h.type, variant: "MW3", participantCount: 3, preflopLevel: 3 });
    for (const h of HAND_TYPES) combos.push({ scenario: "FACING_3BET", position: pos, handType: h.type, variant: "MW4", participantCount: 4, preflopLevel: 3 });
    for (const h of HAND_TYPES) combos.push({ scenario: "FACING_3BET", position: pos, handType: h.type, variant: "4BET", participantCount: 3, preflopLevel: 4 });
  }
  for (const target of PREFLOP_BOOST_TARGETS) {
    for (let vi = 1; vi < VARIANT_TAGS.length; vi++) {
      for (const h of HAND_TYPES) combos.push({ scenario: target.scenario, position: target.position, handType: h.type, variant: VARIANT_TAGS[vi] });
    }
  }
  // Reforço geral de RFI (ver comentário de GENERAL_PREFLOP_BOOST_TARGETS acima) — cobre as 9
  // posições de forma uniforme, corrigindo o gargalo real de UTG/UTG1/MP/MP1/LJ/HJ.
  for (const target of GENERAL_PREFLOP_BOOST_TARGETS) {
    for (let vi = 1; vi < GENERAL_PREFLOP_BOOST_COUNT; vi++) {
      const variant = variantTag(vi);
      for (const h of HAND_TYPES) combos.push({ scenario: target.scenario, position: target.position, handType: h.type, variant });
    }
  }
  const rng = mulberry32(hashStr(`${faseKey}-PREFLOP-BANK-FULL-v5`));
  return shuffle(combos, rng);
}
// ---------- Construção de cartas por "bucket" de força de mão (pós-flop) ----------
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
function drawCard(used, rng, opts = {}) {
  const values = opts.values || range(2, 14);
  const suits = opts.suits || SUITS;
  const candidates = [];
  for (const v of values) for (const s of suits) { const key = v + s; if (!used.has(key)) candidates.push({ v, s, key }); }
  if (!candidates.length) return null;
  const c = candidates[Math.floor(rng() * candidates.length)];
  used.add(c.key);
  return { v: c.v, s: c.s };
}
function brickCard(used, rng, excludeValues = []) {
  return drawCard(used, rng, { values: range(2, 14).filter((v) => !excludeValues.includes(v)) });
}
// Carta extra (turn/river) que RESPEITA a identidade do bucket — nunca deixa uma carta aleatória
// completar um projeto, parear a mão do herói do nada, ou "subir" o par do herói pra além do
// que o rótulo do bucket promete. Sem isso, um spot rotulado "AR" podia virar dois pares de
// verdade na mesa e a decisão continuava usando a equity de "ar" (~5%) — incoerência real.
function protectedBrick(used, rng, meta) {
  if (!meta) return brickCard(used, rng);
  if (meta.flushSuit) return drawCard(used, rng, { suits: SUITS.filter((s) => s !== meta.flushSuit) });
  if (meta.straightLow != null) return drawCard(used, rng, { values: range(2, 14).filter((v) => v !== meta.straightLow - 1 && v !== meta.straightHigh + 1) });
  if (meta.gutshotNeed != null) return drawCard(used, rng, { values: range(2, 14).filter((v) => v !== meta.gutshotNeed) });
  if (meta.ceilingValue != null) return drawCard(used, rng, { values: range(2, 14).filter((v) => v < meta.ceilingValue) });
  if (meta.protectValues) return brickCard(used, rng, meta.protectValues);
  return brickCard(used, rng);
}
function bucketCore(bucket, used, rng) {
  const draw = (opts) => drawCard(used, rng, opts);
  switch (bucket) {
    case "NUTS_SET": {
      const pv = 2 + Math.floor(rng() * 13);
      const h1 = draw({ values: [pv] }), h2 = draw({ values: [pv] });
      const b1 = draw({ values: [pv] });
      const b2 = draw({ values: range(2, 14).filter((v) => v !== pv) });
      const b3 = draw({ values: range(2, 14).filter((v) => v !== pv && v !== b2.v) });
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3] };
    }
    case "TOP_PAIR_TOP_KICKER": {
      const tv = 9 + Math.floor(rng() * 6);
      const h1 = draw({ values: [tv] });
      let kv; do { kv = 10 + Math.floor(rng() * 5); } while (kv === tv);
      const h2 = draw({ values: [kv] });
      const bTop = draw({ values: [tv] });
      const low1 = draw({ values: range(2, tv - 1).filter((v) => v !== kv) });
      const low2 = draw({ values: range(2, tv - 1).filter((v) => v !== kv && v !== low1.v) });
      // Carta extra não pode vir maior que o "top" do herói, senão deixa de ser top pair.
      return { heroCards: [h1, h2], boardCore: [bTop, low1, low2], meta: { ceilingValue: tv } };
    }
    case "OVERPAIR": {
      const pv = 10 + Math.floor(rng() * 5);
      const h1 = draw({ values: [pv] }), h2 = draw({ values: [pv] });
      const b1 = draw({ values: range(2, pv - 1) });
      const b2 = draw({ values: range(2, pv - 1).filter((v) => v !== b1.v) });
      const b3 = draw({ values: range(2, pv - 1).filter((v) => v !== b1.v && v !== b2.v) });
      // Carta extra não pode igualar/superar o par do herói, senão deixa de ser overpair.
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { ceilingValue: pv } };
    }
    case "TWO_PAIR": {
      const v1 = 6 + Math.floor(rng() * 9); let v2; do { v2 = 6 + Math.floor(rng() * 9); } while (v2 === v1);
      const h1 = draw({ values: [v1] }), h2 = draw({ values: [v2] });
      const bm1 = draw({ values: [v1] }), bm2 = draw({ values: [v2] });
      const b3 = draw({ values: range(2, 14).filter((v) => v !== v1 && v !== v2) });
      // Carta extra não pode parear v1 ou v2, senão vira trinca/full house sem avisar.
      return { heroCards: [h1, h2], boardCore: [bm1, bm2, b3], meta: { protectValues: [v1, v2] } };
    }
    case "MIDDLE_PAIR": {
      const high = draw({ values: range(11, 14) });
      const midVal = 6 + Math.floor(rng() * 4);
      const h1 = draw({ values: [midVal] });
      const bMid = draw({ values: [midVal] });
      const h2 = draw({ values: range(2, 9).filter((v) => v !== midVal) });
      // A carta baixa do board não pode coincidir com o kicker do herói, senão pareia escondido
      // já na construção base (bug encontrado: acontecia até no flop, sem precisar de brick).
      const lowPool = range(2, midVal - 1).filter((v) => v !== h2.v);
      const low = draw({ values: lowPool.length ? lowPool : range(2, midVal - 1) });
      // Carta extra não pode parear o par médio nem o kicker do herói.
      return { heroCards: [h1, h2], boardCore: [high, bMid, low], meta: { protectValues: [midVal, h2.v] } };
    }
    case "FLUSH_DRAW": {
      const F = SUITS[Math.floor(rng() * 4)];
      const h1 = draw({ values: range(6, 14), suits: [F] });
      const h2 = draw({ values: range(6, 14).filter((v) => v !== h1.v), suits: [F] });
      const b1 = draw({ values: range(2, 14), suits: [F] });
      const b2 = draw({ values: range(2, 14).filter((v) => v !== b1.v), suits: [F] });
      const b3 = draw({ values: range(2, 14), suits: SUITS.filter((s) => s !== F) });
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { flushSuit: F } };
    }
    case "OESD": {
      const r = 4 + Math.floor(rng() * 7);
      const h1 = draw({ values: [r] }), h2 = draw({ values: [r + 1] });
      const b1 = draw({ values: [r + 2] }), b2 = draw({ values: [r + 3] });
      const outside = range(2, 14).filter((v) => v < r - 1 || v > r + 4);
      const b3 = draw({ values: outside });
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { straightLow: r, straightHigh: r + 3 } };
    }
    case "GUTSHOT": {
      const r = 2 + Math.floor(rng() * 9);
      const h1 = draw({ values: [r] }), h2 = draw({ values: [r + 1] });
      const b1 = draw({ values: [r + 3] }), b2 = draw({ values: [r + 4] });
      const b3 = draw({ values: range(2, 14).filter((v) => v !== r + 2) });
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { gutshotNeed: r + 2 } };
    }
    case "AIR": {
      const v1 = 2 + Math.floor(rng() * 6); let v2; do { v2 = 2 + Math.floor(rng() * 6); } while (Math.abs(v2 - v1) < 2);
      const h1 = draw({ values: [v1] }), h2 = draw({ values: [v2] });
      const b1 = draw({ values: range(9, 14) });
      const b2 = draw({ values: range(9, 14).filter((v) => v !== b1.v) });
      const b3 = draw({ values: range(9, 14).filter((v) => v !== b1.v && v !== b2.v) });
      // Carta extra não pode parear a mão do herói — senão "ar" vira par/dois pares escondido.
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { protectValues: [v1, v2] } };
    }
    case "OVERCARDS": {
      const v1 = 10 + Math.floor(rng() * 5); let v2; do { v2 = 10 + Math.floor(rng() * 5); } while (v2 === v1);
      const h1 = draw({ values: [v1] }), h2 = draw({ values: [v2] });
      const maxBoard = Math.min(v1, v2) - 2;
      const lo = Math.max(2, maxBoard - 6), hi = Math.max(2, maxBoard);
      const pool = range(lo, hi);
      const b1 = draw({ values: pool });
      const b2 = draw({ values: pool.filter((v) => v !== b1.v) });
      const b3 = draw({ values: pool.filter((v) => v !== b1.v && v !== b2.v) });
      // Carta extra não pode parear a mão do herói, senão "overcards sem par" vira par escondido.
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { protectValues: [v1, v2] } };
    }
    case "BACKDOOR_FLUSH_DRAW": {
      const F = SUITS[Math.floor(rng() * 4)];
      const h1 = draw({ values: range(6, 14), suits: [F] });
      const h2 = draw({ values: range(6, 14).filter((v) => v !== h1.v), suits: [F] });
      const b1 = draw({ values: range(2, 14), suits: [F] });
      const offSuit = SUITS.filter((s) => s !== F);
      const b2 = draw({ values: range(2, 14), suits: offSuit });
      const b3 = draw({ values: range(2, 14), suits: offSuit });
      return { heroCards: [h1, h2], boardCore: [b1, b2, b3], meta: { flushSuit: F } };
    }
    default:
      return bucketCore("AIR", used, rng);
  }
}
const BUCKET_CORE_MAP = { MISSED_FLUSH_DRAW: "FLUSH_DRAW", MISSED_STRAIGHT_DRAW: "OESD", OVERCARDS_MISSED: "OVERCARDS" };
const FLUSH_MANAGED_BUCKETS = ["FLUSH_DRAW", "BACKDOOR_FLUSH_DRAW", "MISSED_FLUSH_DRAW"];
// Buckets que não são sobre color não controlam naipe — com 6-7 cartas sorteadas, existe uma
// chance real de 5 caírem no mesmo naipe por puro acaso, formando um flush escondido que a
// categoria do bucket (ex.: "AR") não previa. Corrige trocando o naipe de uma carta do board.
function deflushify(used, rng, heroCards, board) {
  let currentBoard = board;
  // Repete até não sobrar naipe com 5+ cartas — uma trocada só não resolve quando 6 cartas
  // caíram no mesmo naipe por acaso (sobraria 5 ainda depois de trocar 1).
  for (let attempt = 0; attempt < 5; attempt++) {
    const all = [...heroCards, ...currentBoard];
    const suitCounts = {};
    all.forEach((c) => (suitCounts[c.s] = (suitCounts[c.s] || 0) + 1));
    const flushSuit = Object.keys(suitCounts).find((s) => suitCounts[s] >= 5);
    if (!flushSuit) break;
    const candidates = currentBoard.map((c, i) => ({ c, i })).filter((x) => x.c.s === flushSuit);
    if (!candidates.length) break;
    const target = candidates[Math.floor(rng() * candidates.length)];
    used.delete(target.c.v + target.c.s);
    const altSuits = SUITS.filter((s) => s !== flushSuit && !used.has(target.c.v + s));
    if (!altSuits.length) { used.add(target.c.v + target.c.s); break; }
    const newSuit = altSuits[Math.floor(rng() * altSuits.length)];
    used.add(target.c.v + newSuit);
    currentBoard = currentBoard.map((c, i) => (i === target.i ? { v: target.c.v, s: newSuit } : c));
  }
  return currentBoard;
}
function buildPostflopSpotCards(street, bucket, rng) {
  const coreBucket = BUCKET_CORE_MAP[bucket] || bucket;
  const used = new Set();
  const { heroCards, boardCore, meta } = bucketCore(coreBucket, used, rng);
  let board = [...boardCore];
  if (street === "TURN") board.push(protectedBrick(used, rng, meta));
  else if (street === "RIVER") { board.push(protectedBrick(used, rng, meta)); board.push(protectedBrick(used, rng, meta)); }
  if (!FLUSH_MANAGED_BUCKETS.includes(bucket)) board = deflushify(used, rng, heroCards, board);
  return { heroCards, board };
}

// ---------- Banco pós-flop (EARLY GAME etc / FLOP-TURN-RIVER) — dimensões ampliadas ----------
const POSTFLOP_SCENARIOS = ["CHECKED", "BET_25", "BET_33", "BET_50", "BET_66", "BET_75", "BET_100", "BET_150", "ALL_IN"];
const POSTFLOP_SPR = ["DEEP", "MEDIUM", "SHALLOW"];
const FLOP_BUCKETS = ["NUTS_SET","TOP_PAIR_TOP_KICKER","OVERPAIR","TWO_PAIR","MIDDLE_PAIR","FLUSH_DRAW","OESD","GUTSHOT","AIR","OVERCARDS","BACKDOOR_FLUSH_DRAW"];
const TURN_BUCKETS = ["NUTS_SET","TOP_PAIR_TOP_KICKER","OVERPAIR","TWO_PAIR","MIDDLE_PAIR","FLUSH_DRAW","OESD","GUTSHOT","AIR","OVERCARDS"];
const RIVER_BUCKETS = ["NUTS_SET","TOP_PAIR_TOP_KICKER","OVERPAIR","TWO_PAIR","MIDDLE_PAIR","MISSED_FLUSH_DRAW","MISSED_STRAIGHT_DRAW","AIR","OVERCARDS_MISSED"];
const BUCKET_LABEL_PT = {
  NUTS_SET: "TRINCA / SET", TOP_PAIR_TOP_KICKER: "TOP PAR + TOP KICKER", OVERPAIR: "OVERPAIR",
  TWO_PAIR: "DOIS PARES", MIDDLE_PAIR: "PAR MÉDIO/FRACO", FLUSH_DRAW: "PROJETO DE COLOR",
  OESD: "PROJETO DE SEQUÊNCIA (ABERTO)", GUTSHOT: "PROJETO DE SEQUÊNCIA (GUTSHOT)", AIR: "SEM EQUITY (AR)",
  OVERCARDS: "DUAS CARTAS MAIORES QUE O BOARD", BACKDOOR_FLUSH_DRAW: "PROJETO DE COLOR (BACKDOOR)",
  MISSED_FLUSH_DRAW: "COLOR PERDIDO (BLOQUEIO)", MISSED_STRAIGHT_DRAW: "SEQUÊNCIA PERDIDA (BLOQUEIO)",
  OVERCARDS_MISSED: "OVERCARDS SEM PAR NO RIVER",
};
// Descrição em português corrido do que a mão REALMENTE é — usada na explicação didática,
// pra ninguém precisar decifrar o nome técnico do bucket sozinho. Direta, sem sujeito repetido.
const BUCKET_DESCRIPTION_PT = {
  NUTS_SET: "set formado — uma das mãos mais fortes possíveis neste board",
  TOP_PAIR_TOP_KICKER: "top pair com o kicker mais forte possível",
  OVERPAIR: "pocket pair acima de qualquer carta do board — um overpair",
  TWO_PAIR: "two pair formado com o board",
  MIDDLE_PAIR: "pair formado, mas não o mais alto do board",
  FLUSH_DRAW: "nada pronto ainda — flush draw aberto",
  OESD: "nada pronto ainda — straight draw com as duas pontas abertas (OESD)",
  GUTSHOT: "nada pronto ainda — straight draw que só completa com uma carta específica (gutshot)",
  AIR: "nada conectou com o board — carta alta, sem pair",
  OVERCARDS: "sem pair, mas as duas cartas são mais altas que o board",
  BACKDOOR_FLUSH_DRAW: "backdoor flush draw — precisa de mais duas cartas do mesmo naipe",
  MISSED_FLUSH_DRAW: "flush draw que não completou — sobrou carta alta e os blockers do naipe",
  MISSED_STRAIGHT_DRAW: "straight draw que não completou — sobrou carta alta",
  OVERCARDS_MISSED: "cartas mais altas que o board, mas nenhuma emparelhou",
};
const CATEGORY_DESCRIPTION_PT = [
  "não formou pair — só carta alta",
  "pair formado",
  "two pair formado",
  "trips formado",
  "straight completa",
  "flush completo",
  "full house na mesa",
  "quads formado",
  "straight flush — a mão mais forte do poker",
];
// Como essa mão tende a evoluir dali pra frente — trajetória, não só um número de equity solto.
const HAND_TRAJECTORY_PT = {
  NUTS_SET: "dificilmente essa força cresce mais — já é uma das mãos mais fortes possíveis nesse board",
  TOP_PAIR_TOP_KICKER: "o board pode complicar se sair uma carta que dê dois pares ao adversário, mas a vantagem costuma se manter até o fim",
  OVERPAIR: "o risco maior é o board emparelhar acima do próprio par — fora isso, a força se mantém",
  TWO_PAIR: "pode virar trinca ou full house com uma carta favorável, mas o board também pode ajudar o adversário",
  MIDDLE_PAIR: "melhorar pra dois pares ou trinca é raro — o par costuma seguir como está",
  AIR: "sem uma carta que pareie direto, a chance de melhorar é pequena — e mesmo pareando, pode não ser suficiente",
  OVERCARDS: "melhora se uma das duas cartas parear no board (cerca de um terço das vezes), mas nem sempre é suficiente",
  BACKDOOR_FLUSH_DRAW: "só completa com mais duas cartas seguidas do mesmo naipe — combinação rara",
  MISSED_FLUSH_DRAW: "o river já saiu — essa é a força final da mão",
  MISSED_STRAIGHT_DRAW: "o river já saiu — essa é a força final da mão",
  OVERCARDS_MISSED: "o river já saiu — essa é a força final da mão",
};
// Pra projetos ainda vivos (flush draw / OESD / gutshot), troca a trajetória genérica por uma
// conta concreta de outs — o "com quais cartas isso acontece" que dá peso real ao número de equity.
const DRAW_OUTS = { FLUSH_DRAW: 9, OESD: 8, GUTSHOT: 4 };
function drawTrajectoryText(bucket, street, equity) {
  const outs = DRAW_OUTS[bucket];
  if (!outs) return null;
  const cartasTexto = street === "FLOP" ? "duas cartas por vir (turn e river)" : "uma carta por vir (o river)";
  const projetoTexto = bucket === "FLUSH_DRAW" ? "cinco cartas do mesmo naipe" : "a sequência";
  return `${outs} cartas no baralho fecham ${projetoTexto}, com ${cartasTexto} — a base dos ${equity}% de equity calculados.`;
}
// Contexto do torneio contado como parte da história — cada entrada já embute a preposição
// certa ("no"/"na"/"perto") pra concordar em gênero com o substantivo, e é usada direto depois
// de "O torneio está", sem prefixo fixo (evita erro de concordância entre fases).
const FASE_NARRATIVE_PT = {
  "EARLY GAME": "no começo do torneio, com stacks profundos que toleram mais risco",
  "MID GAME": "no meio do torneio, com os blinds já pesando mais",
  "LATE GAME": "na reta final antes da fase decisiva, com pouca margem para erro",
  "BOLHA ITM": "perto da bolha do dinheiro, onde cada decisão pesa mais",
  "BOLHA FT": "na bolha da mesa final — o momento mais delicado do torneio",
  "FT FINAL": "na mesa final, com o prêmio mudando a cada eliminação",
  "D1 RE-ENTRY": "na janela de re-entry do Dia 1, com rebuy ainda disponível",
  "D1 RE-ENTRY (F)": "no fim da janela de re-entry do Dia 1",
  "D1 BAGGING": "na reta final do Dia 1, buscando o maior stack possível para o Dia 2",
};
// Explica por que a ação escolhida vence as outras duas alternativas — o pedaço que faltava
// pra explicação parar de soar como "decreto" e virar raciocínio de verdade.
function alternativeReasoningText(action, hasDraw) {
  switch (action) {
    case "FOLD":
      return "Continuar custaria fichas no longo prazo — a equity não cobre o que o pote exige.";
    case "CALL":
      return hasDraw
        ? "Aumentar seria demais para um projeto ainda não formado; foldar descartaria uma chance real — pagar é o equilíbrio."
        : "Aumentar infla o pote demais para essa força; foldar descartaria algo que já compensa o preço.";
    case "RAISE":
      return hasDraw
        ? "O projeto tem equity suficiente para uma ação agressiva calculada; sem essa equity, o padrão seria pagar ou dar check."
        : "Só pagar deixaria valor na mesa — a força atual já justifica construir o pote por valor.";
    case "ALL IN":
      return "Com o stack raso, meio-termo não ajuda — ou compromete tudo agora, ou perde o valor da mão.";
    case "CHECK":
      return "Apostar arriscaria fichas sem equity ou valor suficiente — dar check preserva o stack.";
    default:
      return "";
  }
}
function alternativeReasoningTextPreflop(action) {
  switch (action) {
    case "FOLD":
      return "Pagar ou aumentar arriscaria fichas com uma mão abaixo do que essa posição exige.";
    case "CALL":
      return "Aumentar exigiria uma mão mais forte; foldar descartaria algo lucrativo o bastante pra continuar — pagar é o equilíbrio.";
    case "RAISE":
      return "Só pagar (ou abrir sem força) deixaria valor na mesa — a mão já justifica construir o pote agora.";
    default:
      return "";
  }
}
// Compara o EV da ação recomendada com o EV das demais opções legais — é essa diferença em
// fichas, e não só a lógica qualitativa, que efetivamente prova qual escolha é a mais lucrativa.
function evComparisonText(analysis) {
  const entries = Object.entries(analysis.actionEVs || {}).filter(([action]) => action !== analysis.exploitAction);
  if (!entries.length) return "";
  const sorted = entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  const parts = sorted.map(([action, value]) => {
    const label = ACTION_VERDICT_PT[action] || action;
    const num = Number(value);
    return `${label.toLowerCase()} renderia ${num >= 0 ? "+" : ""}${num.toFixed(2)} BB`;
  }).join(", ");
  return ` Comparando em fichas com as demais opções legais desse spot: ${parts} — todas abaixo do EV da ação recomendada, o que confirma matematicamente que ela é a escolha que mais preserva ou constrói stack aqui.`;
}
// Rótulo compacto "MIX: X% AÇÃO / Y% AÇÃO" pro cabeçalho do painel — sempre lista só as ações
// com frequência > 0 (nunca mostra "0% RAISE"), e sempre em inglês (jargão de poker). Antes esse
// texto era fixo em "RAISE/CALL/FOLD", então um spot com AÇÃO SUGERIDA: CHECK aparecia sem
// nenhum % de CHECK e jogava o peso dele (ex.: 90%) pro FOLD — contradição direta com a ação
// sugerida. Agora cada mix mostra só as ações que de fato compõem ele.
function mixHeaderText(analysis) {
  const parts = [];
  const push = (freq, labelEn) => { const n = Number(freq); if (n > 0) parts.push(`${freq}% ${labelEn}`); };
  push(analysis.checkFreq, "CHECK");
  push(analysis.raiseFreq, "RAISE");
  push(analysis.callFreq, "CALL");
  push(analysis.foldFreq, "FOLD");
  return parts.length ? parts.join(" / ") : `${ACTION_VERDICT_EN[analysis.exploitAction] || analysis.exploitAction} 100%`;
}
// Explica a mistura de frequências (a estratégia balanceada não escolhe sempre a mesma ação —
// ela dilui o range entre aumentar, pagar e foldar em proporções específicas pra não ficar
// previsível e não abrir brecha pra ser explorada por um adversário observador).
function mixFrequencyText(analysis) {
  const parts = [];
  if (Number(analysis.checkFreq) > 0) parts.push(`${analysis.checkFreq}% dando check`);
  if (Number(analysis.raiseFreq) > 0) parts.push(`${analysis.raiseFreq}% aumentando`);
  if (Number(analysis.callFreq) > 0) parts.push(`${analysis.callFreq}% pagando`);
  if (Number(analysis.foldFreq) > 0) parts.push(`${analysis.foldFreq}% foldando`);
  if (parts.length <= 1) return "";
  return ` Uma estratégia balanceada não resolve esse spot com uma ação só: a mistura ideal aqui divide o range entre ${parts.join(", ")} — jogar sempre a mesma ação com mãos parecidas é o que abre brecha pra um adversário atento explorar o padrão.`;
}
// Explica o que o percentual de confiança realmente mede — não é uma opinião solta, é uma
// estimativa de o quanto o cenário se afasta de um caso limpo e padrão dentro do banco de mãos.
function confidenceText(confidence, participantCount) {
  const base = ` A confiança dessa leitura é de ${confidence}%`;
  if (confidence >= 90) return `${base} — um cenário limpo, direto, com pouca ambiguidade entre as ações.`;
  if (confidence >= 75) return `${base}${participantCount > 2 ? ", um pouco reduzida pela presença de mais jogadores na mão, que aumenta a incerteza sobre o range real de cada adversário" : ""}.`;
  return `${base} — um cenário mais raro ou mais próximo da fronteira entre duas ações, onde a diferença de EV entre elas tende a ser pequena.`;
}
// Explica a matemática do bounty (torneios PKO): o valor de eliminar o adversário soma ao ganho
// em fichas, então o herói pode pagar/continuar com uma mão mais fraca do que pagaria só por
// fichas — o prêmio da eliminação compensa parte do risco.
function bountyExplanationText(bountyState, knockoutValueBB) {
  if (!bountyState) return "";
  const valorTexto = knockoutValueBB != null ? ` — isso equivale a cerca de ${knockoutValueBB.toFixed(1)} BB somados ao valor da mão só em fichas` : "";
  return bountyState.coversVillain
    ? ` Esse é um torneio com bounty, e o herói cobre o stack do adversário: além das fichas do pote, eliminar esse jogador rende o bounty dele${valorTexto} — esse valor extra é o motivo de continuar aqui com uma faixa de mãos mais ampla do que continuaria se estivesse jogando só por fichas.`
    : ` Esse é um torneio com bounty, mas o herói não cobre o stack do adversário — ou seja, mesmo vencendo a mão, não existe eliminação possível aqui, então a decisão volta a ser guiada só pelo valor em fichas, sem o bônus do bounty.`;
}
// FALLBACK ESTÁTICO: usado somente se a simulação de Monte Carlo abaixo falhar por algum motivo
// (ex.: exceção inesperada) — nunca é mais o caminho principal de cálculo de equidade pós-flop,
// mas fica mantido pra garantir que a análise nunca trave por causa disso.
const POSTFLOP_BUCKET_EQUITY = {
  FLOP: { NUTS_SET:92, TOP_PAIR_TOP_KICKER:70, OVERPAIR:74, TWO_PAIR:82, MIDDLE_PAIR:44, FLUSH_DRAW:42, OESD:38, GUTSHOT:20, AIR:7, OVERCARDS:32, BACKDOOR_FLUSH_DRAW:18 },
  TURN: { NUTS_SET:93, TOP_PAIR_TOP_KICKER:71, OVERPAIR:75, TWO_PAIR:83, MIDDLE_PAIR:43, FLUSH_DRAW:20, OESD:17, GUTSHOT:9, AIR:6, OVERCARDS:26 },
  RIVER:{ NUTS_SET:95, TOP_PAIR_TOP_KICKER:72, OVERPAIR:76, TWO_PAIR:85, MIDDLE_PAIR:40, MISSED_FLUSH_DRAW:8, MISSED_STRAIGHT_DRAW:8, AIR:5, OVERCARDS_MISSED:6 },
};
const BET_FRACTION = { BET_25: 0.25, BET_33: 0.33, BET_50: 0.5, BET_66: 0.66, BET_75: 0.75, BET_100: 1.0, BET_150: 1.5 }; // ALL_IN não usa fração — ver generatePostflopBankSpot

// ============================================================
// MOTOR DE EQUIDADE DINÂMICA — SIMULAÇÃO DE MONTE CARLO
// Calcula a equidade real da mão do herói (cartas concretas do spot) contra um range estimado
// do vilão, simulando várias vezes o resto do baralho até completar o board. Substitui a antiga
// tabela estática POSTFLOP_BUCKET_EQUITY como fonte principal de equidade pós-flop.
// ============================================================
const MC_ITERATIONS = 3000; // entre 2.000 e 5.000, conforme pedido — equilíbrio precisão/desempenho
const MC_RANGE_RETRY_LIMIT = 12; // tentativas de amostrar uma mão do vilão dentro do range estimado

// Largura estimada do range de continuação do vilão (top X% de mãos), calibrada pelo tamanho da
// aposta do spot — apostas maiores tendem a carregar um range mais estreito/polarizado.
const RANGE_WIDTH_BY_SCENARIO = { CHECKED: 55, BET_25: 48, BET_33: 44, BET_50: 38, BET_66: 32, BET_75: 28, BET_100: 20, BET_150: 13, ALL_IN: 7 };
const DEFAULT_RANGE_WIDTH = 35;

// Acha o score de Chen que corresponde ao limite de um range de top X% (usa a grade de 169 mãos
// já ranqueada por HAND_TYPES, ordenada do mais forte pro mais fraco).
function chenScoreAtPercentile(pct) {
  let threshold = HAND_TYPES[HAND_TYPES.length - 1].score;
  for (const h of HAND_TYPES) { if (h.percentile <= pct) threshold = h.score; else break; }
  return threshold;
}
// Sorteia 2 cartas distintas de um array de cartas restantes, sem mutar o array original.
function drawTwoDistinct(deck, rng) {
  const n = deck.length;
  const i = Math.floor(rng() * n);
  let j = Math.floor(rng() * (n - 1));
  if (j >= i) j += 1;
  return [deck[i], deck[j]];
}
// Sorteia `count` cartas distintas de um array, sem reposição (Fisher–Yates parcial sobre cópia).
function drawDistinct(deck, count, rng) {
  if (count <= 0) return [];
  const arr = deck.slice();
  const n = arr.length;
  const take = Math.min(count, n);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (n - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, take);
}
// Simulação principal: `seed` garante determinismo (mesmo spot sempre devolve a mesma equidade).
// `softFactor` (campo + modalidade combinados) alarga ou estreita o range estimado do vilão:
// campo/modalidade mais soft = adversário joga um leque mais largo; mais duro = leque mais
// apertado — o mesmo softFactor que ajusta os limites do motor estratégico.
function postflopVillainRangeWidth(entry, spot, softFactor) {
  const scenarioWidth = (entry && RANGE_WIDTH_BY_SCENARIO[entry.scenario]) || DEFAULT_RANGE_WIDTH;
  const positionFactor = ["CO", "BTN", "SB"].includes(entry?.villainPos) ? 1.12
    : ["UTG", "UTG1", "MP"].includes(entry?.villainPos) ? 0.84
    : 1;
  const preflopFactor = entry?.context === "3BET_POT" ? (entry.preflopLevel === 4 ? 0.58 : 0.72) : 1;
  const multiwayFactor = Math.max(0.62, 1 - Math.max(0, (spot.participantCount || 2) - 2) * 0.13);
  const headsUpFactor = entry?.rangeProfile === "HU" || entry?.tableStructure === "HU_2MAX" ? 1.32 : 1;
  return Math.min(88, Math.max(5, scenarioWidth * positionFactor * preflopFactor * multiwayFactor * headsUpFactor * softFactor));
}

// Borda do range SUAVE em vez de corte rígido — GRAU 1 (aproximação de solver): a versão
// anterior aceitava uma mão do vilão só se chenScore >= limiar (tudo acima entra com peso igual,
// tudo abaixo é impossível), o que produz uma borda de range fisicamente irreal — ranges
// resolvidos de verdade têm bordas MISTAS (mãos perto do limiar entram só uma fração das vezes).
// Uma logística centrada no limiar aproxima esse comportamento sem precisar resolver o jogo:
// ~3-4 pontos de Chen Score acima/abaixo do limiar já cobre a faixa de transição de ~10% a ~90%
// de inclusão (softness=1.6 escolhido pra isso, calibrado à escala típica do Chen Score 0-20).
const RANGE_EDGE_SOFTNESS = 1.6;
function rangeInclusionProbability(score, threshold) {
  return 1 / (1 + Math.exp(-(score - threshold) / RANGE_EDGE_SOFTNESS));
}
// widthOverridePct: usado pelo cálculo de fold equity (buildPolicyActionEVs) pra simular a
// equidade do herói contra o CONTINUING RANGE do vilão (a fatia mais forte do range original que
// sobra depois que a parte mais fraca desiste de um raise/aposta) — sem isso, teria que duplicar
// toda a lógica de amostragem só pra rodar contra um range mais estreito.
function simulatePostflopEquityMonteCarlo(heroCards, board, entry, spot, seed, softFactor = 1.0, iterations = MC_ITERATIONS, widthOverridePct = null) {
  const rng = mulberry32(hashStr(seed));
  const usedKeys = new Set([...heroCards, ...board].map((c) => c.v + c.s));
  const remainingDeck = buildDeck().filter((c) => !usedKeys.has(c.v + c.s));
  const cardsToComplete = 5 - board.length;
  const widthPct = widthOverridePct != null ? widthOverridePct : postflopVillainRangeWidth(entry, spot, softFactor);
  const scoreThreshold = chenScoreAtPercentile(widthPct);
  const opponentCount = Math.max(1, (entry && entry.participantCount ? entry.participantCount : 2) - 1);

  let equityPoints = 0;
  for (let i = 0; i < iterations; i++) {
    // Amostra todos os adversários ativos sem reutilizar cartas. Em multiway, o herói precisa
    // superar cada range simultaneamente — não apenas um vilão representativo.
    const villainHoles = [];
    const iterationBlocked = new Set(usedKeys);
    for (let opponent = 0; opponent < opponentCount; opponent++) {
      const available = remainingDeck.filter((c) => !iterationBlocked.has(c.v + c.s));
      let villainHole = drawTwoDistinct(available, rng);
      for (let attempt = 0; attempt < MC_RANGE_RETRY_LIMIT; attempt++) {
        if (rng() < rangeInclusionProbability(chenScore(villainHole[0], villainHole[1]), scoreThreshold)) break;
        villainHole = drawTwoDistinct(available, rng);
      }
      villainHoles.push(villainHole);
      villainHole.forEach((c) => iterationBlocked.add(c.v + c.s));
    }
    const runoutPool = remainingDeck.filter((c) => !iterationBlocked.has(c.v + c.s));
    const runout = drawDistinct(runoutPool, cardsToComplete, rng);
    const fullBoard = [...board, ...runout];

    const heroRank = evalHandFull([...heroCards, ...fullBoard]);
    let lost = false, tied = false;
    for (const villainHole of villainHoles) {
      const villainRank = evalHandFull([...villainHole, ...fullBoard]);
      const cmp = compareHandRank(heroRank, villainRank);
      if (cmp < 0) { lost = true; break; }
      if (cmp === 0) tied = true;
    }
    equityPoints += lost ? 0 : tied ? 0.5 : 1;
  }
  return (equityPoints / iterations) * 100;
}
// Wrapper público: monta a seed determinística do spot, roda a simulação e, se algo falhar por
// qualquer motivo, cai pro heurístico estático antigo — nunca deixa a análise travar.
function computePostflopEquity(heroCards, board, postflopEntry, spot, softFactor) {
  try {
    const stateKey = `${spot.street}|${spot.heroPosition}|${postflopEntry?.villainPos || "-"}|${postflopEntry?.scenario || "CHECKED"}|` +
      `${postflopEntry?.context || "SINGLE_RAISED"}|${postflopEntry?.preflopLevel || 2}|${spot.participantCount || 2}|` +
      `${postflopEntry?.tableStructure || "STANDARD"}|${postflopEntry?.lineKey || "-"}|${(postflopEntry?.actionHistory || []).join(">")}|` +
      `${(spot.pot / spot.bb).toFixed(2)}|${(spot.currentBet / spot.bb).toFixed(2)}`;
    const seed = `MC-STATE|${stateKey}|${heroCards.map((c) => c.v + c.s).join(",")}|${board.map((c) => c.v + c.s).join(",")}`;
    const equity = simulatePostflopEquityMonteCarlo(heroCards, board, postflopEntry, spot, seed, softFactor);
    if (Number.isFinite(equity)) return Math.min(99, Math.max(1, equity));
  } catch {
    // Nunca deixa uma falha inesperada na simulação travar a análise — cai pro fallback abaixo.
  }
  if (postflopEntry && POSTFLOP_BUCKET_EQUITY[spot.street] && POSTFLOP_BUCKET_EQUITY[spot.street][postflopEntry.bucket] != null) {
    return POSTFLOP_BUCKET_EQUITY[spot.street][postflopEntry.bucket];
  }
  const { category } = evalHand([...heroCards, ...board]);
  return Math.min(99, CATEGORY_EQUITY[category] + drawBonus(heroCards, board));
}

// ============================================================
// MATRIZ DE TEXTURA DO BOARD
// Classifica o board (Flop/Turn/River) em categorias técnicas usadas tanto nas explicações
// didáticas quanto na escolha do tamanho de aposta sugerido.
// ============================================================
const BOARD_TEXTURE_LABEL_PT = {
  "PRÉ-FLOP": "sem board ainda — a leitura de textura só existe a partir do flop",
  MONOTONE: "board monocromático — três ou mais cartas do mesmo naipe, flush já é ameaça real",
  PAIRED: "board parelhado — carta repetida abre espaço para full house e trips escondido",
  WET: "board molhado — naipes combinados ou cartas vizinhas sustentam vários draws",
  DRY: "board seco — cartas espalhadas, poucos draws plausíveis para o adversário",
};
function classifyBoardTexture(board) {
  if (!board || board.length < 3) {
    return { category: "PRÉ-FLOP", label: BOARD_TEXTURE_LABEL_PT["PRÉ-FLOP"], isMonotone: false, isPaired: false, isTwoTone: false, isConnected: false, wet: false };
  }
  const suitCounts = {};
  board.forEach((c) => { suitCounts[c.s] = (suitCounts[c.s] || 0) + 1; });
  const maxSuitCount = Math.max(...Object.values(suitCounts));
  const isMonotone = maxSuitCount === board.length && maxSuitCount >= 3;
  const isTwoTone = !isMonotone && maxSuitCount >= 2;

  const values = board.map((c) => c.v);
  const uniqueValues = [...new Set(values)];
  const isPaired = uniqueValues.length < values.length;

  // Conectividade: existe uma janela de até 4 pontos (ex.: 6-7-8-9) cobrindo 3+ valores
  // distintos do board — sinal de que sequências já estão perto de completar.
  const sortedVals = [...uniqueValues].sort((a, b) => a - b);
  let bestWindow = 1;
  for (let i = 0; i < sortedVals.length; i++) {
    let count = 1;
    for (let j = i + 1; j < sortedVals.length; j++) if (sortedVals[j] - sortedVals[i] <= 4) count++;
    bestWindow = Math.max(bestWindow, count);
  }
  const isConnected = bestWindow >= 3;
  const wet = isTwoTone || isConnected;

  let category;
  if (isMonotone) category = "MONOTONE";
  else if (isPaired) category = "PAIRED";
  else if (wet) category = "WET";
  else category = "DRY";

  return { category, label: BOARD_TEXTURE_LABEL_PT[category], isMonotone, isPaired, isTwoTone, isConnected, wet };
}

// ============================================================
// MULTI-SIZING — ESTRUTURA DE APOSTAS PÓS-FLOP
// Tamanhos sugeridos quando a decisão do motor estratégico é apostar/aumentar, escolhidos a partir
// da textura do board e da equidade da mão (proxy de vantagem de alcance nesse spot específico).
// Independente do BET_FRACTION acima, que descreve o tamanho que O VILÃO já apostou no spot.
// ============================================================
const BET_SIZING_TIERS = { SMALL: 0.33, MEDIUM: 0.75, OVERBET: 1.25 };
const SIZING_LABEL_PT = { SMALL: "BET PEQUENO (33% DO POT)", MEDIUM: "BET MÉDIO (75% DO POT)", OVERBET: "OVERBET (125% DO POT)" };
function suggestBetSizing(texture, equityNum) {
  // Board seco + vantagem de alcance clara (equity acima da média): overbet cobra o máximo
  // possível, já que o board raramente ajuda quem está atrás.
  if (texture.category === "DRY" && equityNum >= 72) {
    return { tier: "OVERBET", fraction: BET_SIZING_TIERS.OVERBET,
      reason: "o board raramente melhora quem está atrás, e a força já justifica cobrar o máximo possível" };
  }
  // Board parelhado ou monocromático: tamanhos menores protegem o pot contra o full house ou
  // o flush que esse tipo de board já carrega como ameaça.
  if (texture.category === "PAIRED" || texture.category === "MONOTONE") {
    return { tier: "SMALL", fraction: BET_SIZING_TIERS.SMALL,
      reason: "tamanho menor protege o pot — o board já carrega risco de mão feita contra o herói" };
  }
  // Board molhado: tamanho médio pressiona os draws sem virar all-in disfarçado.
  if (texture.wet) {
    return { tier: "MEDIUM", fraction: BET_SIZING_TIERS.MEDIUM,
      reason: "tamanho médio cobra os draws possíveis sem comprometer fichas demais" };
  }
  // Board seco sem vantagem de alcance clara o bastante para polarizar: tamanho médio equilibrado.
  return { tier: "MEDIUM", fraction: BET_SIZING_TIERS.MEDIUM,
    reason: "sem vantagem de alcance clara o bastante para polarizar, o tamanho médio mantém a linha equilibrada" };
}
// Reforço pós-flop por posição — quantas variantes cada uma recebe no banco normal (pote único).
// Todas as 10 posições agora recebem variantes extras (antes só CO/BTN/BB tinham boost) —
// medição real mostrou que qualquer posição, combinada com fase+street, podia cair bem abaixo
// do piso de 5.000 quando o herói filtra por ela sozinho (mínimo encontrado: 1.291, ver
// AGENTS.md). BB continua com mais variantes (12) porque o treino de defesa de BB filtra uma
// posição só e sozinho precisa cobrir o próprio piso; as demais (5-6) bastam porque a maioria
// dos treinos de posição combina 2+ posições ao mesmo tempo (ex: CO+BTN).
const POSTFLOP_BOOST_CONFIG = { UTG: 20, UTG1: 20, MP: 20, MP1: 20, LJ: 20, HJ: 20, CO: 15, BTN: 15, SB: 20, BB: 24 };
function buildPostflopBank(faseKey, street) {
  const buckets = street === "RIVER" ? RIVER_BUCKETS : street === "TURN" ? TURN_BUCKETS : FLOP_BUCKETS;
  const combos = [];
  for (const pos of POSITIONS_ORDER) for (const scenario of POSTFLOP_SCENARIOS) for (const bucket of buckets) for (const spr of POSTFLOP_SPR) {
    combos.push({ position: pos, scenario, bucket, spr, variant: "A", participantCount: 2, preflopLevel: 2 });
    combos.push({ position: pos, scenario, bucket, spr, variant: "MW3", participantCount: 3, preflopLevel: 2 });
    combos.push({ position: pos, scenario, bucket, spr, variant: "MW4", participantCount: 4, preflopLevel: 2 });
  }
  // BUG CORRIGIDO: indexava VARIANT_TAGS[vi] direto — como POSTFLOP_BOOST_CONFIG pede até 24
  // variantes (BB) e VARIANT_TAGS só tem 12, vi>=12 devolvia `undefined`, criando registros
  // literalmente idênticos (mesma posição/cenário/bucket/spr/variant) dentro do próprio banco.
  // Agora usa variantTag() (sem teto) e também alterna participantCount/preflopLevel entre
  // heads-up/3-way/4-way como o laço base acima já faz — antes as variantes de reforço saíam
  // todas heads-up (participantCount nunca era definido aqui), perdendo a variedade multiway
  // que o laço base tem.
  for (const [pos, variantCount] of Object.entries(POSTFLOP_BOOST_CONFIG)) {
    for (let vi = 1; vi < variantCount; vi++) {
      const variant = variantTag(vi);
      const mwSlot = vi % 3;
      const participantCount = mwSlot === 0 ? 2 : mwSlot === 1 ? 3 : 4;
      for (const scenario of POSTFLOP_SCENARIOS) for (const bucket of buckets) for (const spr of POSTFLOP_SPR) combos.push({ position: pos, scenario, bucket, spr, variant, participantCount, preflopLevel: 2 });
    }
  }
  const rng = mulberry32(hashStr(`${faseKey}-${street}-BANK-FULL-v4`));
  return shuffle(combos, rng);
}
// Banco pós-flop de POTE DE 3-BET: mesma grade de posição/cenário/bucket/SPR do banco normal
// acima, mas marcado com context:"3BET_POT" pra representar continuação depois de um 3-bet
// pago no pré-flop (pote maior, SPR mais raso — ver generatePostflopBankSpot). heroRole diz se,
// nesse spot específico, o herói é quem 3-betou (c-bet/barrel) ou quem pagou o 3-bet (check-call/
// check-raise) — dividido de forma determinística e equilibrada entre as combinações.
// 2 variantes (sem boost por posição, já que o treino que puxa esse banco — RAISE vs 3BET — não
// filtra posição nenhuma) garantem 2.000+ spots reais mesmo no RIVER.
const THREEBET_VARIANT_COUNT = 4;
function buildThreebetPostflopBank(faseKey, street) {
  const buckets = street === "RIVER" ? RIVER_BUCKETS : street === "TURN" ? TURN_BUCKETS : FLOP_BUCKETS;
  const combos = [];
  for (let vi = 0; vi < THREEBET_VARIANT_COUNT; vi++) {
    const variant = VARIANT_TAGS[vi];
    const participantCount = vi === 0 ? 2 : vi === 1 ? 3 : vi === 2 ? 4 : 3;
    const preflopLevel = vi === 3 ? 4 : 3;
    for (const pos of POSITIONS_ORDER) {
      for (const scenario of POSTFLOP_SCENARIOS) {
        for (const bucket of buckets) {
          for (const spr of POSTFLOP_SPR) {
            const heroRole = hashStr(`${pos}|${scenario}|${bucket}|${spr}|${variant}|3BETPOT-ROLE`) % 2 === 0 ? "3BETTOR" : "CALLER";
            combos.push({ position: pos, scenario, bucket, spr, variant, context: "3BET_POT", heroRole, participantCount, preflopLevel });
          }
        }
      }
    }
  }
  const rng = mulberry32(hashStr(`${faseKey}-${street}-3BETPOT-BANK-v1`));
  return shuffle(combos, rng);
}
// Banco mestre: única fonte de verdade. Fase, street e presets nunca criam bancos paralelos;
// eles apenas selecionam registros deste array. Em vez de pré-construir as 36 combinações de
// fase×street inteiras no carregamento do módulo (~783 mil registros, o que custava a maior
// parte do tempo até a primeira tela ficar pronta), cada combinação é construída sob demanda,
// na primeira vez que é pedida, e fica guardada em cache — a partir daí o acesso é imediato.
// O conteúdo de cada combinação é idêntico ao do banco eager antigo (mesma função, mesma
// ordem); a única mudança é QUANDO ele é calculado.
const GENERAL_SPOT_CACHE = {};
function buildGeneralSpotEntries(faseKey, streetKey) {
  let entries;
  if (streetKey === "PRE-FLOP") {
    entries = buildPreflopBank(faseKey);
  } else {
    // Mistura o banco pós-flop normal com o banco de pote de 3-bet numa ordem própria — os
    // dois entram no mesmo pool geral (MIXED sorteia entre eles normalmente), e o preset
    // REAÇÃO A 3-BET filtra só os marcados como context:"3BET_POT" (ver filterPostflopBankByPreset).
    const normalEntries = buildPostflopBank(faseKey, streetKey);
    const threebetEntries = buildThreebetPostflopBank(faseKey, streetKey);
    const mergeRng = mulberry32(hashStr(`${faseKey}-${streetKey}-MERGE-v1`));
    entries = shuffle([...normalEntries, ...threebetEntries], mergeRng);
  }
  // Expansão exclusivamente aditiva: preserva a ordem/IDs legados e só anexa assinaturas
  // estratégicas que ainda não existem neste recorte de fase/street.
  const signatures = new Set(entries.map((entry) => strategicSignature({ ...entry, fase: faseKey, street: streetKey })));
  for (const extension of buildStrategicExpansionEntries(faseKey, streetKey)) {
    const candidate = { ...extension, fase: faseKey, street: streetKey };
    const signature = strategicSignature(candidate);
    if (!signatures.has(signature)) { entries.push(extension); signatures.add(signature); }
  }
  return entries.map((entry, index) => ({
    ...entry,
    id: `${faseKey}|${streetKey}|${String(index + 1).padStart(5, "0")}`,
    fase: faseKey,
    street: streetKey,
  }));
}

function selectGeneralSpots(faseKey, streetKey) {
  const cacheKey = `${faseKey}|${streetKey}`;
  if (!GENERAL_SPOT_CACHE[cacheKey]) GENERAL_SPOT_CACHE[cacheKey] = buildGeneralSpotEntries(faseKey, streetKey);
  return GENERAL_SPOT_CACHE[cacheKey];
}

function filterPreflopBankByPreset(bank, preset) {
  if (!preset) return bank;
  const filtered = bank.filter((e) => {
    if (preset.customMatch) return preset.customMatch(e);
    if (EXPANSION_PRESETS.some((item) => item.key === preset.key)) return matchesExpansionPreset(e, preset);
    if (preset.heroPositions && !preset.heroPositions.includes(e.position)) return false;
    if (preset.scenario && e.scenario !== preset.scenario) return false;
    return true;
  });
  return filtered;
}
// TREINO POR POSIÇÃO: filtro cumulativo aplicado só quando NÃO há preset específico ativo (o
// preset, quando ativo, só combina com a FASE — ver AGENTS.md). ALEATÓRIO não filtra nada.
// Fallback seguro: se a combinação com fase/street ficar vazia, devolve o banco sem filtrar
// em vez de travar o treino.
function filterBankByHeroPosition(bank, positionFilter) {
  if (!positionFilter || positionFilter === "ALEATORIO") return bank;
  const filtered = bank.filter((e) => e.position === positionFilter);
  return filtered.length ? filtered : bank;
}
function filterPostflopBankByPreset(bank, preset) {
  if (!preset) return bank;
  const filtered = bank.filter((e) => {
    if (EXPANSION_PRESETS.some((item) => item.key === preset.key)) return matchesExpansionPreset(e, preset);
    if (preset.heroPositions && !preset.heroPositions.includes(e.position)) return false;
    // postflopContext filtra entre pote normal (undefined) e pote de 3-bet ("3BET_POT").
    if (preset.postflopContext && e.context !== preset.postflopContext) return false;
    return true;
  });
  return filtered;
}

function generatePostflopBankSpot(cfg, faseCfg, street) {
  let presetFiltered = filterPostflopBankByPreset(selectGeneralSpots(cfg.fase, street), cfg.preset);
  // TREINO POR POSIÇÃO combina com FASE e STREET, mas só no treino geral (ver nota equivalente
  // em generatePreflopBankSpot).
  if (!cfg.preset) presetFiltered = filterBankByHeroPosition(presetFiltered, cfg.heroPositionFilter);
  const bank = filterBankByTableSize(presetFiltered, cfg.tableSize);
  const { entry, virtualIndex, variationIndex, virtualPoolLength } = selectSessionVariation(bank, cfg);
  const seedStr = `PFBANK-${cfg.fase}-${street}|${entry.position}|${entry.scenario}|${entry.bucket}|${entry.spr}|${entry.variant||"A"}|${virtualIndex}|${cfg.sessionSeed}`;
  const rng = mulberry32(hashStr(seedStr));
  const { heroCards, board } = buildPostflopSpotCards(street, entry.bucket, rng);

  const bb = faseCfg.nivel * 200, sb = faseCfg.nivel * 100;
  const fieldFactor = combinedStackFactor(cfg); // campo + modalidade combinados
  // entry.stackRange: mesmo gancho que generatePreflopBankSpot já usa — só é preenchido por
  // registros escolhidos pela GERAÇÃO DE SPOTS POR IA (buildAiForcedEntry), nunca pelo banco
  // local normal (que sempre varia o stack em tempo real dentro da faixa da fase).
  let heroStackBB = entry.stackRange
    ? Math.round(entry.stackRange[0] + rng() * (entry.stackRange[1] - entry.stackRange[0]))
    : Math.round((faseCfg.stackMin + rng() * (faseCfg.stackMax - faseCfg.stackMin)) * fieldFactor);
  if (entry.scenario === "OPEN_SHOVE") heroStackBB = Math.min(18, Math.max(5, heroStackBB));
  if (["FACING_SHOVE", "RESHOVE"].includes(entry.scenario)) heroStackBB = Math.min(25, Math.max(8, heroStackBB));
  // TREINO POR STACK: quando o usuário escolhe uma profundidade específica, ela tem prioridade
  // sobre os clamps automáticos por cenário acima — o usuário pediu treino NAQUELA profundidade,
  // mesmo que o cenário normalmente ocorra numa faixa diferente. Pequena variação de ±1 BB só
  // pra não repetir o número exato toda vez.
  if (cfg.stackFilterBB) heroStackBB = Math.max(2, Math.round(cfg.stackFilterBB + (rng() - 0.5) * 2));
  const heroStack = heroStackBB * bb;
  const isThreebetPot = entry.context === "3BET_POT";
  const participantCount = Math.max(2, entry.participantCount || 2);
  const isFourbetPot = entry.preflopLevel === 4;
  // Pote de 3-bet: SPR proporcionalmente mais raso (parte do stack já foi pro meio no pré-flop
  // com a abertura + 3-bet + call) e um piso de pote maior — reflete blinds + abertura + 3-bet +
  // call já dentro do pote antes mesmo do flop sair.
  const sprFactor = isFourbetPot
    ? (entry.spr === "SHALLOW" ? 0.42 : entry.spr === "MEDIUM" ? 0.24 : 0.12)
    : isThreebetPot
    ? (entry.spr === "SHALLOW" ? 0.32 : entry.spr === "MEDIUM" ? 0.16 : 0.07)
    : (entry.spr === "SHALLOW" ? 0.5 : entry.spr === "MEDIUM" ? 0.25 : 0.12);
  const multiwayPotFactor = 1 + (participantCount - 2) * 0.45;
  const potBB = Math.max(isFourbetPot ? 18 : isThreebetPot ? 9 : 4, Math.round(heroStackBB * sprFactor * multiwayPotFactor));
  const potBeforeBet = potBB * bb;

  let currentBet = 0;
  if (entry.scenario === "ALL_IN") {
    // ALL_IN é sempre exatamente o stack efetivo do herói, não uma fração do pote — o vilão
    // aposta tudo o que o herói tem, independentemente do SPR da mão.
    currentBet = heroStack;
  } else if (entry.scenario !== "CHECKED") {
    // Nenhum adversário pode apostar mais do que o stack efetivo do herói neste spot.
    currentBet = Math.min(heroStack, Math.round(potBeforeBet * BET_FRACTION[entry.scenario]));
  }
  // O pote exibido/usado nos cálculos de pot odds precisa já incluir a aposta do vilão
  // (é assim que os outros dois geradores — pré-flop e legado — já funcionam).
  // O vilão real do spot também respeita o filtro de tamanho de mesa (treino de 6-max não deve
  // sortear um vilão em MP1, que nem existe numa mesa de 6) — com fallback pra qualquer posição
  // se por acaso não sobrar nenhuma candidata dentro do filtro.
  const allowedPositions = TABLE_SIZE_POSITIONS[cfg.tableSize] || TABLE_SIZE_POSITIONS[10];
  const allowedOthers = POSITIONS_ORDER.filter((p) => p !== entry.position && allowedPositions.has(p));
  const others = allowedOthers.length ? allowedOthers : POSITIONS_ORDER.filter((p) => p !== entry.position);
  const villainPos = others[Math.floor(rng() * others.length)];
  const heroActionIdx = POSTFLOP_ACTION_ORDER.indexOf(entry.position);
  const villainActionIdx = POSTFLOP_ACTION_ORDER.indexOf(villainPos);
  const remainingOthers = others.filter((p) => p !== villainPos);
  const eligibleSupport = remainingOthers.filter((pos) => {
    const idx = POSTFLOP_ACTION_ORDER.indexOf(pos);
    if (entry.scenario === "CHECKED") return idx >= 0 && idx < heroActionIdx;
    if (villainActionIdx < heroActionIdx) return idx > villainActionIdx && idx < heroActionIdx;
    return idx > villainActionIdx || idx < heroActionIdx;
  });
  const supportCount = Math.min(participantCount - 2, eligibleSupport.length);
  const multiwayPositions = shuffle(eligibleSupport, rng).slice(0, supportCount);
  const actualParticipantCount = 2 + multiwayPositions.length;
  // Todos os participantes adicionais selecionados permanecem na mão e respondem à aposta
  // antes da decisão do herói. CHECK nunca é permitido depois que a aposta existe.
  const callersBeforeHero = entry.scenario === "CHECKED" ? 0 : multiwayPositions.length;
  const pot = potBeforeBet + currentBet * (1 + callersBeforeHero);

  const seatsRaw = POSITIONS_ORDER.map((pos) => {
    if (pos === entry.position) return { pos, isHero: true, cards: heroCards, action: null, stackBB: heroStackBB, stackChips: heroStack, betBB: 0, betChips: 0 };
    const randomStackBB = Math.round((faseCfg.stackMin + rng() * (faseCfg.stackMax - faseCfg.stackMin)) * fieldFactor);
    let action = "FOLD", betChips = 0;
    if (pos === villainPos) { action = entry.scenario === "CHECKED" ? "CHECK" : "BET"; betChips = currentBet; }
    const supportIdx = multiwayPositions.indexOf(pos);
    if (supportIdx >= 0) {
      action = entry.scenario === "CHECKED" ? "CHECK" : "CALL";
      betChips = entry.scenario === "CHECKED" ? 0 : currentBet;
    }
    const stackBB = Math.max(randomStackBB, Math.ceil(betChips / bb));
    return { pos, isHero: false, cards: null, action, stackBB, stackChips: stackBB * bb, betBB: +(betChips / bb).toFixed(1), betChips };
  });
  const seats = POS_LABELS.map((pos) => seatsRaw.find((s) => s.pos === pos));
  const bountyState = cfg.modalidade === "bounty" ? {
    heroBountyBB: +(4 + rng() * 8).toFixed(1), villainBountyBB: +(6 + rng() * 18).toFixed(1),
    coversVillain: heroStackBB >= Math.max(...seatsRaw.filter((seat) => !seat.isHero && seat.action !== "FOLD").map((seat) => seat.stackBB || 0), 0),
    availableBounties: Math.max(1, actualParticipantCount - 1),
  } : null;

  return {
    heroCards, board, street, seats, pot, currentBet, facingBet: currentBet > 0, callChips: currentBet,
    heroStack, heroStackBB, bb, sb, ante: bb, nivel: faseCfg.nivel, faseCfg, heroPosition: entry.position,
    bankEntry: null, postflopEntry: { ...entry, participantCount: actualParticipantCount, villainPos, villainPositions: [villainPos, ...multiwayPositions] },
    multiwayPositions, participantCount: actualParticipantCount, bountyState,
    trainingVariation: { virtualIndex, variationIndex, virtualPoolLength, sourceId: entry.id },
  };
}

// ---------- Config gerais ----------
const MODALIDADES = [
  { key: "regular", label: "NORMAL" }, { key: "turbo", label: "TURBO" }, { key: "freezeout", label: "FREEZEOUT" },
  { key: "bounty", label: "BOUNTY" }, { key: "highroller", label: "HIGHROLLER" }, { key: "multiday", label: "MULTI-DAY" },
];
// Fator de ajuste de ICM por tipo de torneio — bounty/multiday afrouxam um pouco (menos pressão
// de ICM), turbo/highroller apertam (estrutura mais rápida ou campo mais forte); freezeout/normal
// ficam no baseline (x1.0).
const MODALIDADE_ICM_FACTOR = { bounty: 0.9, turbo: 1.05, highroller: 1.1, multiday: 0.95 };
// Softness por modalidade (multiplica com FIELD_SOFT): highroller filtra jogador fraco pelo
// buy-in alto (campo bem mais duro); bounty atrai mais recreativo perseguindo o knockout (mais
// solto); multiday, por ser mais paciente/acessível em re-entries, também puxa um pouco pro lado
// recreativo; turbo tende a concentrar grinder de volume (levemente mais duro); freezeout/normal
// ficam no baseline.
const MODALIDADE_SOFT = { regular: 1.0, turbo: 0.95, freezeout: 1.0, bounty: 1.1, highroller: 0.6, multiday: 1.05 };
// Profundidade de stack por modalidade (multiplica com FIELD_STACK_FACTOR): turbo tem menos mãos
// entre subidas de nível, então a mesma "fase" já chega proporcionalmente mais rasa; highroller e
// multiday costumam ter estruturas mais lentas/profundas; bounty é levemente mais rápido que o
// normal (parte do valor sai via knockout, não só via fichas); freezeout/normal = baseline.
const MODALIDADE_STACK_FACTOR = { regular: 1.0, turbo: 0.75, freezeout: 1.0, bounty: 0.95, highroller: 1.15, multiday: 1.3 };
function combinedStackFactor(cfg) {
  return fieldStackFactor(cfg.field) * (MODALIDADE_STACK_FACTOR[cfg.modalidade] || 1.0);
}
function combinedSoftFactor(cfg) {
  return (FIELD_SOFT[cfg.field] || 1.0) * (MODALIDADE_SOFT[cfg.modalidade] || 1.0);
}
// Ajuste de tamanho de abertura/3-bet pré-flop por modalidade — formatos rápidos/rasos abrem e
// re-levantam proporcionalmente maior (menos espaço pra jogo pós-flop, mais push-fold); formatos
// profundos/pacientes ficam com sizing mais padrão/menor.
const MODALIDADE_RAISE_FACTOR = { regular: 1.0, turbo: 1.12, freezeout: 1.0, bounty: 1.05, highroller: 0.95, multiday: 0.92 };
function modalidadeRaiseFactor(cfg) { return MODALIDADE_RAISE_FACTOR[cfg.modalidade] || 1.0; }
const FIELDS = [50, 100, 250, 500, 1000];
// Softness do campo (usada no ajuste populacional): campos menores tendem a ter uma
// proporção maior de jogador recreativo, campos maiores concentram mais grinder/regular.
const FIELD_SOFT = { 50: 1.35, 100: 1.15, 250: 1.0, 500: 0.85, 1000: 0.7 };
// Fator de profundidade de stack por tamanho de campo: campos maiores costumam ter estruturas
// mais longas (mais níveis até o dinheiro), o que se traduz em stacks efetivos proporcionalmente
// mais fundos na mesma fase do torneio — e, por consequência, potes e apostas também maiores em
// BB (o cálculo de pote já deriva do stack do herói). Campos pequenos, o oposto: estrutura mais
// curta, stacks mais rasos pra mesma fase.
const FIELD_STACK_FACTOR = { 50: 0.85, 100: 1.0, 250: 1.1, 500: 1.2, 1000: 1.3 };
function fieldStackFactor(field) { return FIELD_STACK_FACTOR[field] || 1.0; }
const MIXES = [
  { key: "50", label: "50% REC 25% REG 25% PRO", rec: 50 },
  { key: "60", label: "60% REC 20% REG 20% PRO", rec: 60 },
  { key: "70", label: "70% REC 15% REG 15% PRO", rec: 70 },
];
const TABLES = [2, 6, 8, 9, 10];
const SPOTS_OPTIONS = [200, 500, 1000, 1500, 2000]; // 5000 (MIN_TRAINING_VARIATIONS) é só o piso do espaço
// amostral por baixo — a sobra além do que o usuário escolhe aqui garante variação praticamente
// inédita nos spots, não uma sessão de treino de 5000+ mãos.
const FASES = [
  { key: "EARLY GAME", nivel: 1, nivelMax: 8, stackMin: 50, stackMax: 100, icm: 0.9 },
  { key: "MID GAME", nivel: 9, nivelMax: 14, stackMin: 28, stackMax: 60, icm: 1.0 },
  { key: "LATE GAME", nivel: 15, nivelMax: 18, stackMin: 16, stackMax: 40, icm: 1.1 },
  { key: "BOLHA ITM", nivel: 19, nivelMax: 22, stackMin: 10, stackMax: 30, icm: 1.3 },
  { key: "BOLHA FT", nivel: 23, nivelMax: 26, stackMin: 10, stackMax: 26, icm: 1.35 },
  { key: "FT FINAL", nivel: 27, nivelMax: 35, stackMin: 14, stackMax: 38, icm: 1.2 },
  { key: "D1 RE-ENTRY", nivel: 3, nivelMax: 11, stackMin: 40, stackMax: 90, icm: 0.75 },
  { key: "D1 RE-ENTRY (F)", nivel: 12, nivelMax: 17, stackMin: 25, stackMax: 65, icm: 1.05 },
  { key: "D1 BAGGING", nivel: 18, nivelMax: 22, stackMin: 15, stackMax: 45, icm: 1.2 },
];
// Cada spot percorre o intervalo real de níveis da fase selecionada. Ao completar o intervalo,
// ele reinicia dentro da mesma fase para manter variedade sem invadir a fase seguinte.
function blindLevelForSpot(faseCfg, spotIndex) {
  const first = Number(faseCfg.nivel || 1);
  const last = Math.max(first, Number(faseCfg.nivelMax || first));
  const span = last - first + 1;
  return first + ((Math.max(1, Number(spotIndex || 1)) - 1) % span);
}
// Rótulo de exibição — só muda o texto mostrado na tela/relatórios; a key interna ("D1 RE-ENTRY"
// / "D1 RE-ENTRY (F)") continua igual em todo o resto do código (banco, progresso, histórico).
const FASE_DISPLAY_LABEL = { "D1 RE-ENTRY": "DIA 1 RE", "D1 RE-ENTRY (F)": "DIA 1 LATE", ALEATORIO: "ALEATÓRIO" };
function faseDisplayLabel(key) { return FASE_DISPLAY_LABEL[key] || key; }
// Ordem de progressão automática — segue a ordem horizontal dos cards de FASE (a mesma ordem do
// array FASES acima, exibida na grade 3x3). Ao terminar a meta de uma fase, o treino sempre
// avança pra fase imediatamente seguinte nessa ordem, sem exceção.
const PROGRESSION_ORDER = FASES.map((f) => f.key);
const STREETS_ROW1 = [{ key: "MIXED", label: "ALEATÓRIO" }, { key: "PRE-FLOP", label: "PRÉ-FLOP" }];
const STREETS_ROW2 = [{ key: "FLOP", label: "FLOP" }, { key: "TURN", label: "TURN" }, { key: "RIVER", label: "RIVER" }];
// TREINO POR POSIÇÃO: mesma ordem visual usada na mesa (SB, BB) seguida da ordem de ação
// pré-flop das demais posições de 8-max/9-max — não inclui UTG1/MP1 pra manter o filtro simples.
const HERO_POSITION_FILTER_OPTIONS = ["ALEATORIO", "SB", "BB", "UTG", "MP", "HJ", "LJ", "CO", "BTN"];
// TREINO POR STACK: 9 profundidades específicas (curto pro fundo), 3 por linha. O "motor
// matemático" pra gerar spots nessas profundidades é o mesmo já usado por presets com
// stackRange (ver generatePreflopBankSpot/generatePostflopBankSpot) — como o stack é sorteado
// EM TEMPO REAL a cada spot (não fica gravado no banco), restringir a faixa não reduz a
// diversidade de mão/posição/cenário por baixo, então o piso de 5.000 já vale automaticamente
// pra qualquer profundidade escolhida, sem precisar expandir banco nenhum.
const STACK_OPTIONS = [10, 15, 18, 20, 25, 30, 50, 80, 100];
// ---------- Geração: banco fixo pré-flop (por fase) ----------
function generatePreflopBankSpot(cfg, faseCfg) {
  let presetFiltered = filterPreflopBankByPreset(selectGeneralSpots(cfg.fase, "PRE-FLOP"), cfg.preset);
  // TREINO POR POSIÇÃO combina com FASE e STREET, mas só no treino geral — um preset específico
  // ativo ignora esse filtro (combina apenas com a fase).
  if (!cfg.preset) presetFiltered = filterBankByHeroPosition(presetFiltered, cfg.heroPositionFilter);
  // No treino geral, controla a incidência por categoria em vez de deixar o volume físico de
  // registros decidir sozinho. Os treinos específicos ignoram estes pesos e filtram diretamente.
  if (!cfg.preset) {
    const weightedScenarios = [
      ["RFI", 20], ["FACING_RAISE", 20], ["FACING_3BET", 15],
      ["OPEN_SHOVE", 9], ["FACING_SHOVE", 9], ["RESHOVE", 8], ["MULTI_SHOVE", 5],
      ["SQUEEZE", 7], ["ISOLATE_LIMPERS", 5], ["LIMP_RAISE", 2],
    ];
    const roll = hashStr(`PREFLOP-WEIGHT|${cfg.fase}|${cfg.spotIndex}|${cfg.sessionSeed}`) % 100;
    let cumulative = 0;
    const selectedScenario = weightedScenarios.find(([, weight]) => (cumulative += weight) > roll)?.[0] || "RFI";
    const scenarioEntries = presetFiltered.filter((entry) => entry.scenario === selectedScenario);
    if (scenarioEntries.length) presetFiltered = scenarioEntries;
  }
  const bank = filterBankByTableSize(presetFiltered, cfg.tableSize);
  const { entry, virtualIndex, variationIndex, virtualPoolLength } = selectSessionVariation(bank, cfg);
  const seedStr = `PFBANK-${cfg.fase}|${entry.position}|${entry.scenario}|${entry.handType}|${entry.variant||"A"}|${virtualIndex}|${cfg.sessionSeed}`;
  const rng = mulberry32(hashStr(seedStr));
  const resolvedHandType = HAND_TYPE_MAP[entry.handType]
    ? entry.handType
    : HAND_TYPES[hashStr(`${entry.id}|${virtualIndex}|${cfg.sessionSeed}|HAND`) % HAND_TYPES.length].type;
  const h = HAND_TYPE_MAP[resolvedHandType];
  const suitsShuffled = shuffle(SUITS, rng);
  let c1, c2;
  if (h.pair) { c1 = { v: h.a, s: suitsShuffled[0] }; c2 = { v: h.a, s: suitsShuffled[1] }; }
  else if (h.suited) { const s = suitsShuffled[0]; c1 = { v: h.a, s }; c2 = { v: h.b, s }; }
  else { c1 = { v: h.a, s: suitsShuffled[0] }; c2 = { v: h.b, s: suitsShuffled[1] }; }
  const heroCards = [c1, c2];

  const bb = faseCfg.nivel * 200, sb = faseCfg.nivel * 100;
  const fieldFactor = combinedStackFactor(cfg); // campo + modalidade combinados
  const generatedStackBB = Math.round((faseCfg.stackMin + rng() * (faseCfg.stackMax - faseCfg.stackMin)) * fieldFactor);
  const heroStackBB = cfg.stackFilterBB
    ? Math.max(2, Math.round(cfg.stackFilterBB + (rng() - 0.5) * 2))
    : entry.stackRange
    ? Math.round(entry.stackRange[0] + rng() * (entry.stackRange[1] - entry.stackRange[0]))
    : generatedStackBB;
  const heroStack = heroStackBB * bb;
  const allowedPositions = TABLE_SIZE_POSITIONS[cfg.tableSize] || TABLE_SIZE_POSITIONS[10];

  let openerPos = null, openRaiseBB = 0, threebettorPos = null, heroOpenBB = 0, threebetBB = 0;
  const raiseFactor = modalidadeRaiseFactor(cfg);
  if (["COLD_CALL_3BET","COLD_4BET"].includes(entry.strategicNode)) {
    const heroIdx = POSITIONS_ORDER.indexOf(entry.position);
    const candidates = POSITIONS_ORDER.slice(0, heroIdx).filter((p) => allowedPositions.has(p));
    openerPos = candidates[0] || "UTG";
    threebettorPos = candidates[candidates.length - 1] || "HJ";
    if (threebettorPos === openerPos && candidates.length > 1) threebettorPos = candidates[1];
    openRaiseBB = +((2.2 + rng() * 0.8) * raiseFactor).toFixed(1);
    threebetBB = +(openRaiseBB * (2.8 + rng() * 0.8)).toFixed(1);
    heroOpenBB = entry.position === "BB" ? 1 : entry.position === "SB" ? 0.5 : 0;
  } else if (["FACING_RAISE", "FACING_SHOVE", "RESHOVE", "SQUEEZE", "MULTI_SHOVE"].includes(entry.scenario)) {
    const heroIdx = POSITIONS_ORDER.indexOf(entry.position);
    // Candidatos a abridor: quem age antes do herói E existe no tamanho de mesa selecionado —
    // com fallback pra ignorar o filtro de mesa se não sobrar ninguém (mesa pequena demais pra
    // essa posição de herói ter alguém antes dela dentro do recorte).
    let candidates = POSITIONS_ORDER.slice(0, heroIdx).filter((p) => allowedPositions.has(p));
    if (["RESHOVE", "SQUEEZE", "MULTI_SHOVE"].includes(entry.scenario)) {
      candidates = POSITIONS_ORDER.slice(0, Math.max(1, heroIdx - 1)).filter((p) => allowedPositions.has(p));
    }
    if (cfg.preset && cfg.preset.openerGroup) {
      const narrowed = candidates.filter((p) => cfg.preset.openerGroup.includes(p));
      if (narrowed.length) candidates = narrowed;
    }
    if (!candidates.length) candidates = POSITIONS_ORDER.slice(0, heroIdx);
    openerPos = candidates.length ? candidates[Math.floor(rng() * candidates.length)] : POSITIONS_ORDER[Math.floor(rng() * heroIdx)];
    openRaiseBB = ["FACING_SHOVE", "MULTI_SHOVE"].includes(entry.scenario)
      ? Math.min(heroStackBB, Math.max(6, +(8 + rng() * 14).toFixed(1)))
      : +((2.2 + rng() * 1.3) * raiseFactor).toFixed(1);
  } else if (["FACING_3BET", "LIMP_RAISE"].includes(entry.scenario)) {
    // O herói abriu (RFI) e agora enfrenta um 3-bet de alguém que ainda estava pra agir.
    const heroIdx = POSITIONS_ORDER.indexOf(entry.position);
    let candidates = POSITIONS_ORDER.slice(heroIdx + 1).filter((p) => allowedPositions.has(p));
    if (cfg.preset && cfg.preset.threebettorGroup) {
      const narrowed = candidates.filter((p) => cfg.preset.threebettorGroup.includes(p));
      if (narrowed.length) candidates = narrowed;
    }
    if (!candidates.length) candidates = POSITIONS_ORDER.slice(heroIdx + 1);
    threebettorPos = candidates.length ? candidates[Math.floor(rng() * candidates.length)] : POSITIONS_ORDER[POSITIONS_ORDER.length - 1];
    heroOpenBB = entry.scenario === "LIMP_RAISE" ? 1 : entry.preflopLevel === 4
      ? +((6.5 + rng() * 2.5) * raiseFactor).toFixed(1)
      : +((2.2 + rng() * 0.8) * raiseFactor).toFixed(1);
    threebetBB = entry.scenario === "LIMP_RAISE" ? +((4 + rng() * 2) * raiseFactor).toFixed(1) : entry.preflopLevel === 4
      ? +(heroOpenBB * (2.05 + rng() * 0.45)).toFixed(1)
      : +(heroOpenBB * (2.8 + rng() * 1.0)).toFixed(1);
    // Evita gerar uma aposta maior do que todo o stack do herói.
    threebetBB = Math.min(heroStackBB, threebetBB);
  }
  const participantCount = Math.max(2, entry.participantCount || 2);
  const heroIdxForMultiway = POSITIONS_ORDER.indexOf(entry.position);
  const occupied = new Set([entry.position, openerPos, threebettorPos].filter(Boolean));
  let supportPool = POSITIONS_ORDER.filter((p) => allowedPositions.has(p) && !occupied.has(p));
  if (["RFI", "FACING_RAISE", "FACING_SHOVE", "RESHOVE", "SQUEEZE", "ISOLATE_LIMPERS", "MULTI_SHOVE"].includes(entry.scenario)) {
    const actedBeforeHero = new Set(POSITIONS_ORDER.slice(0, heroIdxForMultiway));
    supportPool = supportPool.filter((p) => actedBeforeHero.has(p));
    if (["RESHOVE", "SQUEEZE", "MULTI_SHOVE"].includes(entry.scenario)) {
      const openerIdx = POSITIONS_ORDER.indexOf(openerPos);
      supportPool = supportPool.filter((p) => POSITIONS_ORDER.indexOf(p) > openerIdx);
    }
  } else if (["FACING_3BET", "LIMP_RAISE"].includes(entry.scenario)) {
    if (entry.scenario === "LIMP_RAISE") {
      const raiserIdx = POSITIONS_ORDER.indexOf(threebettorPos);
      supportPool = supportPool.filter((p) => {
        const idx = POSITIONS_ORDER.indexOf(p);
        return idx > heroIdxForMultiway && idx < raiserIdx;
      });
    } else {
    const threeIdxForMultiway = POSITIONS_ORDER.indexOf(threebettorPos);
    // Só pode pagar a 3-bet antes da decisão final do herói quem está depois do 3-bettor
    // ou quem será alcançado após a ação atravessar o fim da mesa e voltar ao herói.
    supportPool = supportPool.filter((p) => {
      const idx = POSITIONS_ORDER.indexOf(p);
      return idx > threeIdxForMultiway || idx < heroIdxForMultiway;
    });
    }
  }
  const multiwayPositions = shuffle(supportPool, rng).slice(0, Math.min(participantCount - 2, supportPool.length));
  const actualParticipantCount = 2 + multiwayPositions.length;
  // Cópia do entry específica desse spot, com opener/3-bettor embutidos — os cálculos de
  // threshold precisam saber QUEM agiu de verdade. Nunca muta o array compartilhado do banco
  // (cada geração usa sua própria cópia).
  const entryForSpot = ["COLD_CALL_3BET","COLD_4BET"].includes(entry.strategicNode) ? { ...entry, openerPos, threebettorPos }
    : ["FACING_RAISE", "FACING_SHOVE", "RESHOVE", "SQUEEZE", "MULTI_SHOVE"].includes(entry.scenario) ? { ...entry, openerPos }
    : ["FACING_3BET", "LIMP_RAISE"].includes(entry.scenario) ? { ...entry, threebettorPos }
    : entry;

  let pot, currentBet, callChips;
  const seatsRaw = POSITIONS_ORDER.map((pos) => {
    if (pos === entry.position) {
      const forcedBlindBB = pos === "BB" ? 1 : pos === "SB" ? 0.5 : 0;
      const coldNode = ["COLD_CALL_3BET","COLD_4BET"].includes(entry.strategicNode);
      const heroBetBB = coldNode ? forcedBlindBB : ["FACING_3BET", "LIMP_RAISE"].includes(entry.scenario) ? heroOpenBB : forcedBlindBB;
      const priorHeroAction = coldNode ? null : entry.scenario === "FACING_3BET" ? "RAISE" : entry.scenario === "LIMP_RAISE" ? "LIMP" : null;
      return { pos, isHero: true, cards: heroCards, action: priorHeroAction, stackBB: heroStackBB, stackChips: heroStack, betBB: heroBetBB, betChips: Math.round(heroBetBB * bb) };
    }
    // Blinds são compromissos já pagos na street, mesmo quando o jogador acaba foldando.
    let action = "FOLD", betBB = pos === "BB" ? 1 : pos === "SB" ? 0.5 : 0;
    if (["FACING_RAISE", "RESHOVE", "SQUEEZE"].includes(entry.scenario) && pos === openerPos) { action = "RAISE"; betBB = openRaiseBB; }
    if (["FACING_SHOVE", "MULTI_SHOVE"].includes(entry.scenario) && pos === openerPos) { action = "ALL IN"; betBB = openRaiseBB; }
    if (["COLD_CALL_3BET","COLD_4BET"].includes(entry.strategicNode) && pos === openerPos) { action = "RAISE"; betBB = openRaiseBB; }
    if (["FACING_3BET", "LIMP_RAISE"].includes(entry.scenario) && pos === threebettorPos) { action = "RAISE"; betBB = threebetBB; }
    if (multiwayPositions.includes(pos)) {
      const posIdx = POSITIONS_ORDER.indexOf(pos);
      const openerIdx = POSITIONS_ORDER.indexOf(openerPos);
      const isLimp = ["RFI", "ISOLATE_LIMPERS", "LIMP_RAISE"].includes(entry.scenario) || (["FACING_RAISE", "RESHOVE", "SQUEEZE"].includes(entry.scenario) && posIdx < openerIdx);
      action = entry.scenario === "MULTI_SHOVE" ? "ALL IN" : isLimp ? "LIMP" : "CALL";
      if (entry.scenario === "MULTI_SHOVE") {
        const shoveIndex = multiwayPositions.indexOf(pos);
        const stackTier = Math.max(4, openRaiseBB + (shoveIndex + 1) * (3 + Math.floor(rng() * 7)));
        betBB = Math.min(heroStackBB, +stackTier.toFixed(1));
      } else {
        betBB = isLimp ? 1 : entry.scenario === "FACING_3BET" ? threebetBB : openRaiseBB;
      }
    }
    const randomStackBB = Math.round((faseCfg.stackMin + rng() * (faseCfg.stackMax - faseCfg.stackMin)) * fieldFactor);
    const stackBB = entry.scenario === "MULTI_SHOVE" && action === "ALL IN"
      ? Math.max(1, betBB)
      : Math.max(randomStackBB, Math.ceil(betBB) + (pos === "BB" ? 1 : 0));
    const betChips = Math.round(betBB * bb);
    return { pos, isHero: false, cards: null, action, stackBB, stackChips: stackBB * bb, betBB, betChips };
  });
  // Reconciliação universal: o BB ante entra uma vez; cada assento contribui com seu total
  // acumulado na street. Isso funciona igualmente para blind-fold, limp, call, raise, 3-bet,
  // 4-bet e shove, sem duplicar blinds que já estejam incorporados numa aposta maior.
  const heroSeatRaw = seatsRaw.find((seat) => seat.isHero);
  pot = bb + seatsRaw.reduce((sum, seat) => sum + Number(seat.betChips || 0), 0);
  currentBet = seatsRaw.reduce((highest, seat) => Math.max(highest, Number(seat.betChips || 0)), bb);
  callChips = Math.max(0, currentBet - Number(heroSeatRaw?.betChips || 0));
  const seats = POS_LABELS.map((pos) => seatsRaw.find((s) => s.pos === pos));

  const isFreeCheckNode = ["BB_VS_LIMPERS","HU_BB_VS_LIMP"].includes(entry.strategicNode);
  const isFacingBet = !isFreeCheckNode && !["RFI", "OPEN_SHOVE"].includes(entry.scenario);
  const bountyState = cfg.modalidade === "bounty" || entry.strategicNode === "PKO_KO" ? {
    heroBountyBB: entry.heroBountyBB || +(4 + rng() * 8).toFixed(1),
    villainBountyBB: entry.villainBountyBB || +(6 + rng() * 18).toFixed(1),
    coversVillain: entry.coversVillain ?? heroStackBB >= Math.max(5, openRaiseBB || threebetBB || heroStackBB * 0.7),
    availableBounties: entry.availableBounties || Math.max(1, actualParticipantCount - 1),
  } : null;
  return {
    heroCards, board: [], street: "PRE-FLOP", seats, pot, currentBet,
    // Em RFI ninguém aumentou antes do herói: os blinds formam o pote, mas não são uma
    // aposta a pagar. Isso mantém CHECK/CALL e o texto "para pagar" coerentes com o spot.
    facingBet: isFacingBet, callChips: isFacingBet ? callChips : 0, heroStack, heroStackBB, bb, sb, ante: bb,
    nivel: faseCfg.nivel, faseCfg, heroPosition: entry.position,
    bankEntry: { ...entryForSpot, participantCount: actualParticipantCount }, openerPos, openRaiseBB, threebettorPos, heroOpenBB, threebetBB,
    multiwayPositions, participantCount: actualParticipantCount, hasMultiShove: entry.scenario === "MULTI_SHOVE",
    handType: resolvedHandType, handPercentile: h.percentile, bountyState,
    trainingVariation: { virtualIndex, variationIndex, virtualPoolLength, sourceId: entry.id },
  };
}

// ---------- Geração: gerador genérico (demais fase/street) ----------
function generateSpotCandidate(cfg) {
  // FASE em ALEATÓRIO sorteia uma fase real por spot (determinístico), do mesmo jeito que
  // street MIXED já sorteia a street — nunca existe uma fase "ALEATÓRIO" de verdade no banco.
  let faseKey = cfg.fase;
  if (!faseKey || faseKey === "ALEATORIO") {
    const faseSeedKey = cfg.preset ? `FASE-ALEATORIO-PRESET-${cfg.preset.key}` : "FASE-ALEATORIO-GERAL";
    const faseRng = mulberry32(hashStr(`${faseSeedKey}-${cfg.spotIndex}`));
    faseKey = FASES[Math.floor(faseRng() * FASES.length)].key;
  }
  const resolvedCfg = faseKey === cfg.fase ? cfg : { ...cfg, fase: faseKey };
  const faseBaseCfg = FASES.find((f) => f.key === faseKey) || FASES[0];
  const faseCfg = { ...faseBaseCfg, nivel: blindLevelForSpot(faseBaseCfg, resolvedCfg.spotIndex) };
  let street = resolvedCfg.street;
  // Banco mestre único: TODO spot — com ou sem preset ativo — sai do GENERAL_SPOT_BANK. MIXED só
  // sorteia QUAL street usar (mantendo o filtro do preset, se houver); nunca existe um caminho
  // paralelo de geração fora do banco. Os botões de treino (presets) são só filtros sobre ele.
  if (!street || street === "MIXED") {
    const seedKey = resolvedCfg.preset ? `MIXED-PRESET-${resolvedCfg.preset.key}` : "MIXED-GERAL";
    const rng = mulberry32(hashStr(`${seedKey}-${faseKey}-${resolvedCfg.spotIndex}`));
    const roll = rng();
    street = roll < 0.35 ? "PRE-FLOP" : roll < 0.60 ? "FLOP" : roll < 0.82 ? "TURN" : "RIVER";
    if (resolvedCfg.preset?.forceStreetPreflop) street = "PRE-FLOP";
    if (resolvedCfg.preset?.forcePostflop && street === "PRE-FLOP") street = "FLOP";
    if (resolvedCfg.preset?.streetOnly) street = resolvedCfg.preset.streetOnly;
  }
  if (resolvedCfg.preset) {
    const filterForStreet = (candidateStreet) => candidateStreet === "PRE-FLOP"
      ? filterPreflopBankByPreset(selectGeneralSpots(faseKey, candidateStreet), resolvedCfg.preset)
      : filterPostflopBankByPreset(selectGeneralSpots(faseKey, candidateStreet), resolvedCfg.preset);
    if (filterForStreet(street).length === 0) {
      const compatible = ["PRE-FLOP","FLOP","TURN","RIVER"].filter((candidateStreet) => filterForStreet(candidateStreet).length > 0);
      if (!compatible.length) throw new Error(`Treino ${resolvedCfg.preset.key} sem estado estratégico compatível.`);
      street = compatible[hashStr(`${resolvedCfg.preset.key}|${resolvedCfg.spotIndex}`) % compatible.length];
    }
  }
  if (street === "PRE-FLOP") return generatePreflopBankSpot(resolvedCfg, faseCfg);
  return generatePostflopBankSpot(resolvedCfg, faseCfg, street);
}

function generateSpot(cfg) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidateCfg = attempt === 0 ? cfg : { ...cfg, spotIndex: cfg.spotIndex + attempt * 997 };
    const candidate = generateSpotCandidate(candidateCfg);
    const integrityErrors = validateSpotIntegrity(candidate);
    if (integrityErrors.length === 0) return { ...candidate, integrityValidated: true };
  }
  throw new Error("Não foi possível gerar um spot matematicamente válido.");
}

// ---------- Análise / decisão ----------
// Gera a mistura RAISE/CALL/FOLD/CHECK sempre com a ação decidida como dominante — evita o bug de
// mostrar "MIX: 65% RAISE" junto de "AÇÃO SUGERIDA: CALL", que são coisas contraditórias.
// CHECK tem sua própria frequência (checkFreq) — antes essa função reaproveitava a fórmula do
// FOLD pra CHECK também (comentário antigo "FOLD ou CHECK"), o que fazia um spot com "AÇÃO
// SUGERIDA: CHECK" exibir a maioria da mistura como "% FOLD", uma contradição direta.
// callLegal: false para cenários onde CALL nunca é uma opção real (RFI, OPEN_SHOVE,
// ISOLATE_LIMPERS, RESHOVE, BB_VS_LIMPERS e os nós HU equivalentes sem CALL na tabela) — nesses
// casos o resto da mistura (que antes vazava pra callFreq, produzindo por exemplo "38% CALL" num
// spot de RFI onde ninguém pagou nada ainda) vai inteiro pro bucket agressivo (raiseFreq, que já
// é reaproveitado como o bucket de ALL IN também — ver buildPolicyActionEVs). Default true
// preserva o comportamento antigo pra qualquer chamador que ainda não passe o parâmetro.
function mixFrequencies(action, confidence, callLegal = true) {
  const dom = 55 + Math.max(0, Math.min(1, confidence)) * 35; // 55-90%, sempre maioria
  const rest = 100 - dom;
  if (action === "RAISE" || action === "ALL IN") {
    if (!callLegal) return { raiseFreq: dom, callFreq: 0, foldFreq: rest, checkFreq: 0 };
    return action === "ALL IN"
      ? { raiseFreq: dom, callFreq: rest, foldFreq: 0, checkFreq: 0 }
      : { raiseFreq: dom, callFreq: rest * 0.65, foldFreq: rest * 0.35, checkFreq: 0 };
  }
  if (action === "CALL") return { raiseFreq: rest * 0.5, callFreq: dom, foldFreq: rest * 0.5, checkFreq: 0 };
  if (action === "CHECK") return { raiseFreq: rest, callFreq: 0, foldFreq: 0, checkFreq: dom };
  // FOLD
  if (!callLegal) return { raiseFreq: rest, callFreq: 0, foldFreq: dom, checkFreq: 0 };
  return { raiseFreq: 0, callFreq: rest, foldFreq: dom, checkFreq: 0 };
}

// GRAU 1 (aproximação de solver): EV real calculado por ação, não mais uma penalidade heurística
// por "distância de frequência/agressividade" (o jeito antigo, que não tinha nenhuma relação com
// o tamanho da aposta real do spot). FOLD/CHECK/CALL usam o mesmo formato de EV líquido já usado
// no resto do arquivo: equity * pote - (1-equity) * risco. RAISE/ALL IN agora modelam FOLD EQUITY
// de verdade via MDF (minimum defense frequency = pote/(pote+aposta) — o piso clássico de quanto
// o vilão PRECISA continuar pra não virar alvo de blefe puro e sempre-lucrativo): quanto maior a
// aposta do herói em relação ao pote, menor a fração do range do vilão que sobra pra continuar, e
// a equidade contra essa fatia que sobra (sempre mais forte que o range inteiro) é recalculada
// via `computeContinueEquity` — pós-flop, isso roda uma segunda passada do próprio motor de Monte
// Carlo contra um range mais estreito (ver computeAnalysis); pré-flop, como não existe simulação
// de equidade real, usa uma leitura mais pessimista do percentil implícito (aproximação, não
// solver — ver comentário em computeAnalysis sobre isso).
// GRAU 2 (calibração por solver real): a fórmula pura de MDF (foldFrequency = 1-mdf) SUPERESTIMA
// a frequência real de fold do vilão — medido contra 24 soluções reais do TexasSolver (CFR,
// offline, licença AGPL v3, rodado localmente — ver commit e resources/solverReference.json).
// Pra uma aposta de 50% do pote a fórmula pura previa 33,3% de fold mas os solves resolvem em
// média ~28,0% (razão 0,84 sobre a previsão teórica); pra apostas maiores o desvio cresce e
// depois estabiliza perto de ~0,72 (150% pote: previsto 60% / solvado ~40,5%; 300%: previsto 75%
// / solvado ~53,8%; 500%: previsto 83,3% / solvado ~59,6%). Faz sentido: a MDF pura é um modelo
// estático de uma street só — o vilão de verdade retém equidade em mãos que "deveriam" foldar
// pela MDF (redraws, implied odds nas streets seguintes), então continua mais do que o piso
// teórico. calibratedFoldFrequency interpola linearmente entre os 4 pontos medidos (β = tamanho
// da aposta em relação ao pote) e, fora desse intervalo, aplica a razão do ponto mais próximo
// sobre a curva teórica — preserva foldFrequency→0 quando β→0 e extrapola de forma conservadora
// pra apostas maiores que 5x o pote.
const FOLD_CALIBRATION_ANCHORS = [
  { beta: 0.5, fold: 0.2798 },
  { beta: 1.5, fold: 0.4045 },
  { beta: 3.0, fold: 0.5381 },
  { beta: 5.0, fold: 0.5963 },
];
function calibratedFoldFrequency(beta) {
  const anchors = FOLD_CALIBRATION_ANCHORS;
  const theoretical = (b) => b / (1 + b);
  const first = anchors[0], last = anchors[anchors.length - 1];
  if (beta <= first.beta) return theoretical(beta) * (first.fold / theoretical(first.beta));
  if (beta >= last.beta) return theoretical(beta) * (last.fold / theoretical(last.beta));
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (beta >= a.beta && beta <= b.beta) {
      const t = (beta - a.beta) / (b.beta - a.beta);
      return a.fold + t * (b.fold - a.fold);
    }
  }
  return theoretical(beta); // inalcançável, fallback de segurança
}
function buildPolicyActionEVs({ spot, finalEquity, potBeforeBB, callChipsBB, raiseSizingBB, computeContinueEquity }) {
  const isPreflop = spot.street === "PRE-FLOP";
  const freeCheckPreflop = isPreflop && ["BB_VS_LIMPERS","HU_BB_VS_LIMP"].includes(spot.bankEntry?.strategicNode);
  const legal = spot.facingBet
    ? ["FOLD", "CALL", "RAISE", "ALL IN"]
    : freeCheckPreflop ? ["CHECK", "RAISE", "ALL IN"] : isPreflop ? ["FOLD", "RAISE", "ALL IN"] : ["CHECK", "RAISE", "ALL IN"];
  const equity = Math.max(1, Math.min(99, Number(finalEquity) || 50));
  const pot = Math.max(0.1, Number(potBeforeBB) || 0.1);
  const callBB = Math.max(0, Number(callChipsBB) || 0);
  const values = {};
  if (legal.includes("FOLD")) values.FOLD = 0;
  if (legal.includes("CHECK")) values.CHECK = (equity / 100) * pot;
  if (legal.includes("CALL")) values.CALL = (equity / 100) * pot - (1 - equity / 100) * callBB;

  const raiseIncrement = {
    RAISE: Math.max(0.5, Number(raiseSizingBB) || pot * 0.66),
    "ALL IN": Math.max(0.5, Number(spot.heroStackBB) || pot * 2),
  };
  for (const action of ["RAISE", "ALL IN"]) {
    if (!legal.includes(action)) continue;
    const inc = raiseIncrement[action];
    const mdf = pot / (pot + inc); // fração mínima que o vilão precisa continuar (senão vira alvo de blefe puro)
    const beta = inc / pot; // tamanho da aposta em relação ao pote — eixo da calibração por solver
    const foldFrequency = Math.max(0.05, Math.min(0.95, calibratedFoldFrequency(beta))); // clamps: range real nunca desiste/continua 100%
    const continueEquity = computeContinueEquity ? computeContinueEquity(mdf, action) : Math.max(3, equity - (1 - mdf) * 30);
    const continueBranch = (continueEquity / 100) * (pot + inc) - (1 - continueEquity / 100) * inc;
    values[action] = foldFrequency * pot + (1 - foldFrequency) * continueBranch;
  }
  return values;
}

function solutionConfidence(spot) {
  let score = spot.street === "PRE-FLOP" ? 96 : 91;
  score -= Math.max(0, (spot.participantCount || 2) - 2) * (spot.street === "PRE-FLOP" ? 4 : 7);
  if (spot.hasMultiShove) score -= 4;
  if (spot.postflopEntry?.context === "3BET_POT") score -= 2;
  return Math.max(62, Math.min(98, Math.round(score)));
}

function assessDecision(action, analysis) {
  const normalized = bucketOf(action) === "ALLIN" ? "ALL IN" : bucketOf(action);
  const values = analysis.actionEVs || {};
  const chosenEV = Number(values[normalized] ?? -99);
  const bestEV = Math.max(...Object.values(values).map(Number));
  const loss = Math.max(0, bestEV - chosenEV);
  const grade = loss <= 0.10 ? "MELHOR DECISÃO"
    : loss <= 0.50 ? "DECISÃO ACEITÁVEL"
    : loss <= 1.50 ? "ERRO MODERADO"
    : "ERRO GRAVE";
  return { chosenEV, bestEV, loss, grade, acceptable: loss <= 0.50 };
}

// Rótulo de 1 linha do card AGUARDANDO AÇÃO/DECISÃO — mapeia cada grade de assessDecision
// (que continua controlando estatísticas, histórico e relatório da IA) pro texto compacto
// exigido nesse card específico. Não altera o valor de `grade` em si, só a exibição aqui.
const DECISION_CARD_ONE_LINER = {
  "MELHOR DECISÃO": "JOGADA PADRÃO (+) EV - BEST PLAY",
  "DECISÃO ACEITÁVEL": "JOGADA AJUSTÁVEL - INACCURACY",
  "ERRO MODERADO": "JOGADA COM ERRO MODERADO - MISTAKE",
  "ERRO GRAVE": "JOGADA COM ERRO GRAVE - SPEW",
};
// Cor da borda/texto do mesmo card, por grade — verde (best play), laranja (inaccuracy),
// vermelho (mistake) e vermelho piscando (spew, erro grave: usa a mesma animação de pulso
// já usada no estado AGUARDANDO AÇÃO, via nlh-blink-border/nlh-blink-text).
const DECISION_CARD_COLOR = {
  "MELHOR DECISÃO": "#22C55E",
  "DECISÃO ACEITÁVEL": "#F97316",
  "ERRO MODERADO": "#EF4444",
  "ERRO GRAVE": "#EF4444",
};
// Só o ERRO GRAVE pisca — reforça visualmente que é o único nível de "alerta ativo" (spew).
const DECISION_CARD_BLINK_GRADES = new Set(["ERRO GRAVE"]);
// Mesmas 4 graduações, como tag curta em inglês — usada só para fechar a explicação didática
// com o veredito real da decisão do herói (ligação explícita entre o card e a prosa dos 35 pontos).
const GRADE_TAG_EN = {
  "MELHOR DECISÃO": "BEST PLAY",
  "DECISÃO ACEITÁVEL": "INACCURACY",
  "ERRO MODERADO": "MISTAKE",
  "ERRO GRAVE": "SPEW",
};

function computeAnalysis(spot, cfg) {
  const softFactor = combinedSoftFactor(cfg); // campo + modalidade combinados
  const mixCfg = MIXES.find((m) => m.key === cfg.mix);
  const mixAdj = (mixCfg.rec - 50) * 0.25;
  const icmFactor = spot.faseCfg.icm * (MODALIDADE_ICM_FACTOR[cfg.modalidade] || 1.0);

  if (spot.bankEntry) {
    const entry = spot.bankEntry;
    const state = buildPreflopEvaluationState(spot);
    const rawPercentile = spot.handPercentile;
    const percentile = rangeMorphologyPercentile(entry.handType, state);
    // A amostragem termina no gerador. As decisões recebem apenas estado estratégico + cartas
    // exatas e são avaliadas por ranges/limiares calibrados; a origem do spot não entra no motor.
    const baseline = preflopRangeDecision(state, percentile, { softFactor: 1, mixAdj: 0, icmFactor: 1 });
    const fieldMix = preflopRangeDecision(state, percentile, { softFactor, mixAdj, icmFactor: 1 });
    const icmOnly = preflopRangeDecision(state, percentile, { softFactor: 1, mixAdj: 0, icmFactor });
    const deltaFieldMix = Math.abs(fieldMix.mainThreshold - baseline.mainThreshold);
    const deltaIcm = Math.abs(icmOnly.mainThreshold - baseline.mainThreshold);
    const dominantIsField = deltaFieldMix >= deltaIcm;
    const dominant = dominantIsField ? fieldMix : icmOnly;
    const dominantLabel = dominantIsField ? "AJUSTE POPULACIONAL" : "PRESSÃO DE TORNEIO";
    let bankConfidence;
    if (dominant.action === "RAISE") {
      const tb = dominant.threebetThreshold || dominant.mainThreshold;
      bankConfidence = tb > 0 ? (tb - percentile) / tb : 1;
    } else if (dominant.action === "CALL") {
      const tb = dominant.threebetThreshold || 0;
      const zoneWidth = Math.max(1, dominant.mainThreshold - tb);
      const distFromEdges = Math.min(percentile - tb, dominant.mainThreshold - percentile);
      bankConfidence = distFromEdges / (zoneWidth / 2);
    } else {
      bankConfidence = (percentile - dominant.mainThreshold) / Math.max(1, 100 - dominant.mainThreshold);
    }
    const { raiseFreq, callFreq, foldFreq, checkFreq } = mixFrequencies(dominant.action, bankConfidence, dominant.callLegal);
    const spr = spot.heroStack / Math.max(spot.pot, 1);
    const alpha = spot.facingBet ? (spot.callChips / (spot.pot + spot.callChips)) * 100 : 0;
    const mdf = 100 - alpha;
    // Aproximação de EV pra spots de pré-flop: sem uma equity de fato calculada (o motor aqui
    // trabalha por percentil de força, não por simulação de mãos), usa uma equity implícita a
    // partir do percentil como referência pra estimar o EV em BB da linha escolhida.
    const impliedEquity = Math.max(3, Math.min(97, 100 - percentile));
    const evBB = dominant.action === "FOLD" ? 0 : ((impliedEquity / 100) * spot.pot - (1 - impliedEquity / 100) * spot.callChips) / spot.bb;
    const potBeforeBB = spot.pot / spot.bb;
    const callChipsBB = spot.callChips / spot.bb;
    // Sem sizing explícito de raise no motor de pré-flop (que trabalha por percentil de força, não
    // por tiers de aposta pós-flop) — deixa buildPolicyActionEVs usar o proxy padrão (66% do pote)
    // pra estimar o tamanho do raise/all in. computeContinueEquity aqui é uma aproximação (não
    // simulação real): sem equity de Monte Carlo no pré-flop, usa a mesma leitura pessimista do
    // percentil implícito já usada no cálculo de evBB acima.
    const actionEVs = buildPolicyActionEVs({
      spot, finalEquity: impliedEquity, potBeforeBB, callChipsBB,
      computeContinueEquity: (mdf) => Math.max(3, Math.min(97, impliedEquity - (1 - mdf) * 30)),
    });
    return {
      isBank: true, entry, percentile: rawPercentile.toFixed(1), rangePercentile: percentile.toFixed(1), dominantLabel,
      solutionKey: `${state.scenario}|${state.position}|${state.openerPos || "-"}|${state.threebettorPos || "-"}|${Math.round(state.effectiveStackBB)}BB|${state.participantCount}P`,
      rangeEngine: "STATE_RANGE_V1", sampleIndependent: true,
      baselineAction: baseline.action, baselineThreshold: baseline.mainThreshold.toFixed(1),
      fieldMixAction: fieldMix.action, fieldMixThreshold: fieldMix.mainThreshold.toFixed(1),
      icmAction: icmOnly.action, icmThreshold: icmOnly.mainThreshold.toFixed(1),
      exploitAction: dominant.action, exploitThreshold: dominant.mainThreshold.toFixed(1),
      threebetThreshold: dominant.threebetThreshold != null ? dominant.threebetThreshold.toFixed(1) : null,
      raiseFreq: raiseFreq.toFixed(0), callFreq: callFreq.toFixed(0), foldFreq: foldFreq.toFixed(0), checkFreq: checkFreq.toFixed(0),
      actionEVs, confidence: solutionConfidence(spot),
      spr: spr.toFixed(1), alpha: alpha.toFixed(1), mdf: mdf.toFixed(1), evBB: evBB.toFixed(2), softFactor, mixAdj, icmFactor,
    };
  }

  const { heroCards, board, pot, callChips, heroStackBB } = spot;
  let baseEquity;
  if (board.length === 0) {
    // Pré-flop: sem board pra simular, mantém o modelo por percentil (Chen Score) — fora do
    // escopo do motor de Monte Carlo, que é especificamente pós-flop.
    const score = chenScore(heroCards[0], heroCards[1]);
    baseEquity = Math.min(85, Math.max(8, 20 + score * 3));
  } else {
    // Pós-flop: equidade real via Monte Carlo — cartas concretas do herói/board contra um
    // range estimado do vilão pelo tamanho da aposta do spot (substitui a tabela estática).
    baseEquity = computePostflopEquity(heroCards, board, spot.postflopEntry, spot, softFactor);
  }
  const boardTexture = classifyBoardTexture(board);
  const fieldMixEquity = Math.min(99, Math.max(2, baseEquity + (softFactor - 1) * 18 + mixAdj));
  const traditionalPotOdds = spot.facingBet ? (callChips / (pot + callChips)) * 100 : 0;
  const bountyMath = bountyDecisionAdjustment(spot, traditionalPotOdds);
  const potOddsNeeded = bountyMath.adjustedEquityRequired;
  const icmThresholdOnly = potOddsNeeded * icmFactor;
  const spr = spot.heroStack / Math.max(pot, 1);
  const alpha = spot.facingBet ? (callChips / (pot + callChips)) * 100 : 0;
  const mdf = spot.facingBet ? 100 - alpha : 100;

  const isDraw = spot.postflopEntry && ["FLUSH_DRAW","OESD","GUTSHOT"].includes(spot.postflopEntry.bucket);
  function decide(equity, threshold) {
    const strongValue = equity >= Math.max(58, threshold + 18);
    const qualifiedDraw = isDraw && equity >= Math.max(30, threshold + 6);
    if (spot.facingBet) {
      if (heroStackBB <= 15 && equity >= 48 && (strongValue || qualifiedDraw)) return "ALL IN";
      if (strongValue || qualifiedDraw) return "RAISE";
      if (equity >= threshold) return "CALL";
      if (isDraw && equity >= threshold - 5) return "CALL";
      return "FOLD";
    }
    if (equity >= 60) return "RAISE";
    if (isDraw && equity >= 30) return "RAISE";
    return "CHECK";
  }
  // Leituras de equilíbrio, população e pressão de torneio calculadas
  // separadamente; a que mais desvia do baseline é considerada "mais eficiente" para aquele spot.
  const baselineAction = decide(baseEquity, potOddsNeeded);
  const fieldMixAction = decide(fieldMixEquity, potOddsNeeded);
  const icmAction = decide(baseEquity, icmThresholdOnly);
  const deltaFieldMix = Math.abs(fieldMixEquity - baseEquity);
  const deltaIcm = Math.abs(icmThresholdOnly - potOddsNeeded);
  const dominantIsField = deltaFieldMix >= deltaIcm;
  const dominantLabel = dominantIsField ? "AJUSTE POPULACIONAL" : "PRESSÃO DE TORNEIO";
  const exploitAction = dominantIsField ? fieldMixAction : icmAction;
  const finalEquity = dominantIsField ? fieldMixEquity : baseEquity;
  const finalThreshold = dominantIsField ? potOddsNeeded : icmThresholdOnly;
  // Quando o CALL só se sustenta por causa da margem de tolerância (equity um pouco abaixo do
  // threshold, mas perto o suficiente pra contar fold equity/implied odds), marca isso pra
  // explicação poder avisar em vez de simplesmente dizer "PAGAR" sem contexto.
  const usedMargin = exploitAction === "CALL" && finalEquity < finalThreshold;
  let legConfidence;
  if (exploitAction === "RAISE") legConfidence = (finalEquity - (finalThreshold + 18)) / 30;
  else if (exploitAction === "ALL IN") legConfidence = (finalEquity - 45) / 30;
  else if (exploitAction === "CALL") legConfidence = 1 - Math.abs(finalEquity - finalThreshold) / 15;
  else if (exploitAction === "FOLD") legConfidence = (finalThreshold - finalEquity) / 20;
  else legConfidence = (60 - finalEquity) / 30; // CHECK
  // decide() só devolve CALL dentro do ramo spot.facingBet — sem aposta enfrentada (RAISE/CHECK)
  // CALL nunca é opção real, então o resto da mistura não pode vazar pra callFreq ali.
  const { raiseFreq, callFreq, foldFreq, checkFreq } = mixFrequencies(exploitAction, legConfidence, !!spot.facingBet);
  const evBB = ((finalEquity / 100) * pot - (1 - finalEquity / 100) * callChips) / spot.bb;

  // Multi-sizing: a exibição (`sizing`) só faz sentido quando a decisão é apostar/aumentar — ALL IN
  // já é um tamanho definido (o stack inteiro), então fica fora da sugestão de tiers. Mas o EV real
  // de RAISE/ALL IN (buildPolicyActionEVs, abaixo) precisa de um tamanho em BB pra QUALQUER spot,
  // não só quando RAISE é a ação recomendada — por isso `chosenSizing`/`raiseSizingBB` são
  // calculados sempre, e só o objeto de exibição `sizing` continua condicional.
  const chosenSizing = suggestBetSizing(boardTexture, finalEquity);
  const raiseSizingBB = (chosenSizing.fraction * pot) / spot.bb;
  let sizing = null;
  if (exploitAction === "RAISE") {
    sizing = { tier: chosenSizing.tier, label: SIZING_LABEL_PT[chosenSizing.tier], fraction: chosenSizing.fraction, bb: raiseSizingBB.toFixed(1), reason: chosenSizing.reason };
  }

  const potBeforeBB = pot / spot.bb;
  const callChipsBB = callChips / spot.bb;
  // computeContinueEquity: quando há board real (pós-flop), roda uma segunda passada do próprio
  // motor de Monte Carlo contra um range mais ESTREITO (a fatia que sobra depois que `1-mdf` do
  // range do vilão desiste do raise/aposta do herói — ver comentário de buildPolicyActionEVs).
  // Sem board (pré-flop, quando esse ramo é alcançado — bank já retornou antes), cai na mesma
  // aproximação por percentil usada no ramo de banco acima, já que não há equity simulada aqui.
  const actionEVs = buildPolicyActionEVs({
    spot, finalEquity, potBeforeBB, callChipsBB, raiseSizingBB,
    computeContinueEquity: (mdf) => {
      if (board.length === 0) return Math.max(3, Math.min(97, finalEquity - (1 - mdf) * 30));
      const seed = `MC-CONTINUE|${spot.street}|${spot.heroPosition}|${spot.postflopEntry?.villainPos || "-"}|` +
        `${heroCards.map((c) => c.v + c.s).join(",")}|${board.map((c) => c.v + c.s).join(",")}|${mdf.toFixed(3)}`;
      const narrowedWidthPct = postflopVillainRangeWidth(spot.postflopEntry, spot, softFactor) * mdf;
      return simulatePostflopEquityMonteCarlo(heroCards, board, spot.postflopEntry, spot, seed, softFactor, 600, narrowedWidthPct);
    },
  });
  return {
    isBank: false, dominantLabel, usedMargin,
    rangeEngine: "STATE_MONTE_CARLO_V1", sampleIndependent: true,
    villainRangeWidth: postflopVillainRangeWidth(spot.postflopEntry, spot, softFactor).toFixed(1),
    baseEquity: baseEquity.toFixed(1), fieldMixEquity: fieldMixEquity.toFixed(1),
    potOddsNeeded: potOddsNeeded.toFixed(1), icmThreshold: icmThresholdOnly.toFixed(1),
    baselineAction, fieldMixAction, icmAction,
    spr: spr.toFixed(1), alpha: alpha.toFixed(1), mdf: mdf.toFixed(1), evBB: evBB.toFixed(2),
    exploitAction, boardTexture, sizing,
    actionEVs, confidence: solutionConfidence(spot), bountyMath,
    raiseFreq: raiseFreq.toFixed(0), callFreq: callFreq.toFixed(0), foldFreq: foldFreq.toFixed(0), checkFreq: checkFreq.toFixed(0), softFactor, icmFactor,
  };
}

function bucketOf(action) {
  if (action.startsWith("RAISE")) return "RAISE";
  if (action === "ALL IN") return "ALLIN";
  return action;
}

// ---------- UI helpers ----------
function SelCard({ active, onClick, children, style }) {
  return (
    <div onClick={onClick} className="rounded-md flex items-center justify-center cursor-pointer text-center px-1" style={{
      height: 42, fontSize: 11, fontWeight: 800, background: "transparent",
      border: active ? "1.5px solid #FACC15" : "1.5px solid #333", color: active ? "#FACC15" : "#FFF",
      boxShadow: active ? "0 0 12px rgba(250,204,21,0.45)" : "none", ...style,
    }}>{children}</div>
  );
}
function ConfigPanel({ open, onToggle, title, summary, color = "#FACC15", minHeight = 40, children }) {
  return (
    <div className="rounded-md flex flex-col gap-2 p-2" style={{ border: `1.5px solid ${color}`, boxShadow: `0 0 12px ${color}4D`, textAlign: "center" }}>
      <button onClick={onToggle} className="rounded-md" style={{ minHeight, border: "none", color, background: `${color}0D`, padding: "5px 8px", fontWeight: 900 }}>
        <div style={{ fontSize: 11, letterSpacing: "0.1em" }}>{title} {open ? "▲" : "▼"}</div>
        <div style={{ fontSize: 11, color: "#FFF", marginTop: 4, letterSpacing: "0.03em" }}>{summary}</div>
      </button>
      {open && <div className="flex flex-col gap-2">{children}</div>}
    </div>
  );
}
// Botão simples de trava — sem texto, fica no canto superior direito de cada seção. Verde =
// destravado (seleção livre), vermelho = travado (seleção da seção fica congelada até destravar).
// Botão de trava — no mesmo padrão visual dos cards de posição (retângulo com borda), com o
// emoji indicando o estado: ❌ travado (seleção da seção congelada), ✅ livre (pode escolher).
function fmtChips(n) {
  // Cadeias de subtração em ponto flutuante (stack - apostas já pagas) podem deixar "poeira"
  // como 7.275957614183426e-12 em vez de 0 exato. Sem essa limpeza, String(n) exibia esse
  // valor em notação científica cru (bug real reportado: "S 7.275957614183426E-12" no stack
  // do BTN após all in). Zera ruído abaixo de 1e-6 e arredonda o resto para 2 casas.
  const value = Math.abs(n) < 1e-6 ? 0 : Math.round(n * 100) / 100;
  if (value >= 1000) {
    const inThousands = value / 1000;
    const oneDecimalIsExact = Math.abs(inThousands * 10 - Math.round(inThousands * 10)) < 0.0001;
    return inThousands.toFixed(oneDecimalIsExact ? 1 : 2) + " K";
  }
  return String(value);
}
function CardPip({ card, hidden }) {
  if (hidden) return <span style={{ fontSize: 15 }}>🂠</span>;
  const rank = card.r || RANKS[card.v - 2];
  return <span style={{ fontSize: 15, fontWeight: 900, color: RED[card.s] ? "#EF4444" : "#F3F4F6" }}>{rank}{card.s}</span>;
}
function strengthLabel(percentile) {
  if (percentile <= 5) return "mão de elite";
  if (percentile <= 12) return "mão forte";
  if (percentile <= 25) return "mão boa";
  if (percentile <= 45) return "mão mediana";
  if (percentile <= 70) return "mão fraca";
  return "mão muito fraca";
}
function equityLabel(eq) {
  const n = parseFloat(eq);
  if (n >= 75) return "força acima da média";
  if (n >= 55) return "boa força para o spot";
  if (n >= 35) return "força mediana";
  if (n >= 15) return "força fraca";
  return "força muito fraca, quase sem chance";
}

function quickActionLabel(action) {
  return ({ FOLD: "FOLD", CALL: "CALL", RAISE: "RAISE COM EQUITY", CHECK: "CHECK", "ALL IN": "ALL-IN" })[action] || action;
}

function sprQuickExplanation(value, suggestedAction) {
  const spr = Number(value);
  const verdict = `neste spot: ${quickActionLabel(suggestedAction)}`;
  if (spr <= 1) return `pote grande para o stack: valor forte ou draw com equity pode pagar/aumentar; mão fraca tende a fold — ${verdict}`;
  if (spr <= 3) return `stack moderado: call exige equity; raise exige valor ou draw com equity suficiente; sem isso, fold — ${verdict}`;
  return `stack profundo: evite comprometer tudo com mão marginal; agressão exige equity e plano para as próximas streets — ${verdict}`;
}

function mdfQuickExplanation(value, facingBet, suggestedAction) {
  if (!facingBet) return "sem aposta enfrentada; MDF não restringe a decisão";
  const mdf = Number(value);
  const rangeAdvice = mdf >= 70
    ? "aposta pequena: defender amplo com calls e raises; foldar a parte mais fraca"
    : mdf >= 55
      ? "defesa intermediária: continuar mãos e draws com equity adequada"
      : "aposta grande: é correto foldar mais e continuar apenas a parte forte do range";
  return `MDF é do range, não desta mão: continuar cerca de ${mdf.toFixed(0)}%; ${rangeAdvice}; nesta mão: ${quickActionLabel(suggestedAction)}`;
}
const ACTION_VERDICT_PT = { FOLD: "FOLDAR", CALL: "PAGAR", RAISE: "AUMENTAR", CHECK: "DAR CHECK", "ALL IN": "IR ALL-IN" };

const STREET_LABEL_PT = { "PRE-FLOP": "PRÉ-FLOP", FLOP: "FLOP", TURN: "TURN", RIVER: "RIVER" };
// Cor do badge de street no card JOGADORES COM AÇÃO — pré-flop verde, flop azul, turn rosa,
// river vermelho.
function streetBadgeColor(street) {
  if (street === "FLOP") return "#3B82F6";
  if (street === "TURN") return "#EC4899";
  if (street === "RIVER") return "#EF4444";
  return "#4ADE80";
}

// Traduz um threshold de percentil (ex.: "top 25%") num range de mãos legível (ex.: "77+, ATs+, AJo+").
// Pares são sempre monotônicos na nossa grade (se um par entra, todos acima também entram).
// Suited/offsuit são compressados em notação "+" a partir do conector mais próximo da carta alta.
function compressRangeToText(thresholdPercentile) {
  const included = new Set(HAND_TYPES.filter((h) => h.percentile <= thresholdPercentile).map((h) => h.type));
  if (included.size === 0) return "praticamente nenhuma mão";
  const parts = [];

  let lowestPair = null;
  for (let v = 2; v <= 14; v++) {
    if (included.has(`${RANKS[v-2]}${RANKS[v-2]}`)) { lowestPair = v; break; }
  }
  if (lowestPair != null) parts.push(lowestPair === 14 ? "AA" : `${RANKS[lowestPair-2]}${RANKS[lowestPair-2]}+`);

  for (const suffix of ["s", "o"]) {
    for (let hi = 14; hi >= 3; hi--) {
      const hiR = RANKS[hi-2];
      if (!included.has(`${hiR}${RANKS[hi-3]}${suffix}`)) continue;
      let lowestConnected = hi - 1;
      for (let lo = hi - 2; lo >= 2; lo--) {
        if (included.has(`${hiR}${RANKS[lo-2]}${suffix}`)) lowestConnected = lo; else break;
      }
      parts.push(lowestConnected === hi - 1 ? `${hiR}${RANKS[lowestConnected-2]}${suffix}` : `${hiR}${RANKS[lowestConnected-2]}${suffix}+`);
    }
  }
  return parts.length ? parts.join(", ") : "praticamente nenhuma mão";
}

// Descreve, em palavras, o range de abertura de uma posição específica (usa a tabela calibrada de RFI).
function positionOpenRangeText(pos) {
  const th = RFI_THRESHOLD[pos];
  if (th == null) return null;
  return { pct: th, text: compressRangeToText(th) };
}

// Qualifica o range do vilão em palavras (largura), pra não repetir sempre a mesma estrutura
// de frase "range de X% — algo como Y".
function rangeWidthQualifier(pct) {
  if (pct <= 15) return "range muito concentrado em valor";
  if (pct <= 30) return "range intermediário, com força relevante";
  return "leque aberto, com bastante mão fraca misturada";
}
// Compara a força da mão do herói contra a largura do range do vilão — a peça que faltava pra
// responder "o vilão tem, no range dele, algo mais forte ou mais fraco do que eu tenho aqui?".
function relativeStrengthText(heroPercentile, villainPct) {
  if (heroPercentile <= villainPct * 0.4) return "supera a maior parte desse range";
  if (heroPercentile <= villainPct) return "fica no meio da força desse range";
  if (heroPercentile <= villainPct * 1.8) return "fica abaixo da força média desse range";
  return "fica bem abaixo da força média — a maioria das mãos dele já vence essa";
}

// Range aproximado de cada jogador num pote pós-flop, a partir do PAPEL que cada um teve no
// pré-flop (abridor/3-bettor/pagador) — reaproveita as mesmas tabelas do pré-flop (RFI_
// THRESHOLD, THREEBET_WIDTH, facingRaiseBaseThresholds). É uma aproximação pela posição e pela
// linha jogada, não um range exato rastreado ação a ação — vale dizer isso onde aparece.
function postflopRangeDescription(pos, role, vsPos) {
  if (role === "3BETTOR") {
    const w = THREEBET_WIDTH[pos] || 8;
    return `top ${w}% (3-bet de ${pos}) — ${compressRangeToText(w)}`;
  }
  if (role === "OPENER") {
    const r = positionOpenRangeText(pos);
    return r ? `top ${r.pct}% (abertura de ${pos}) — ${r.text}` : null;
  }
  if (role === "CALLER" && vsPos) {
    const { callTh } = facingRaiseBaseThresholds(pos, vsPos);
    return `top ${callTh.toFixed(0)}% (defesa de ${pos} vs ${vsPos}) — ${compressRangeToText(callTh)}`;
  }
  return null;
}

function preflopScenarioLabel(entry, spot) {
  const labels = {
    OPEN_SHOVE: `OPEN SHOVE com ${spot.heroStackBB} BB`,
    FACING_SHOVE: `CALL DE SHOVE de ${spot.openerPos} para ${spot.openRaiseBB} BB`,
    MULTI_SHOVE: `MULTI SHOVE com ${(spot.participantCount || 3) - 1} adversários all-in e stacks diferentes`,
    RESHOVE: `RESHOVE após raise de ${spot.openerPos} para ${spot.openRaiseBB} BB e call`,
    SQUEEZE: `SQUEEZE após raise de ${spot.openerPos} para ${spot.openRaiseBB} BB e call(s)`,
    ISOLATE_LIMPERS: `ISOLAMENTO contra ${Math.max(1, (spot.participantCount || 2) - 1)} limper(s)`,
    LIMP_RAISE: `LIMP-RAISE: herói completou 1 BB e enfrenta raise de ${spot.threebettorPos} para ${spot.threebetBB} BB`,
  };
  if (labels[entry.scenario]) return labels[entry.scenario];
  if (entry.scenario === "RFI") return "Abertura (RFI)";
  if (entry.scenario === "FACING_3BET") return `Facing ${entry.preflopLevel === 4 ? "4-bet" : "3-bet"} vs ${spot.threebettorPos} (${spot.threebetBB} BB, sua ação ${spot.heroOpenBB} BB)`;
  return `Facing raise vs ${spot.openerPos} (${spot.openRaiseBB} BB)`;
}

// ============================================================
// CADEIA DE 35 INDICADORES — motor analítico GTO + exploit
// ============================================================
// Substitui o antigo par buildBankExplanation/buildLegacyExplanation. Percorre, sempre na mesma
// ordem, os 35 indicadores clássicos de leitura de mão (GTO + exploit). Cada indicador vira um
// item { n, label, text } com um texto curto e autocontido; a explicação (prosa) e o resumo
// (linhas numeradas) são gerados a partir do MESMO array, então nunca divergem entre si.
//
// Indicadores que dependem de estatística de HUD/tracker real de um oponente específico (3-bet%,
// fold-to-3-bet%, freq. de limp, donk bet%, c-bet%, delay c-bet%, aggression factor, WTSD, W$SD,
// freq. de check-raise) não existem neste treino — cada mão é um spot independente, sem histórico
// entre uma mão e outra. Nesses casos o indicador usa uma média populacional padrão, escalada
// pelo perfil de campo escolhido (softFactor), e o texto deixa isso explícito — não finge ser
// estatística rastreada de verdade.
function populationBaseline(softFactor) {
  const f = softFactor || 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cbet = clamp(68 / f, 45, 85);
  return {
    threebet: clamp(8.5 / f, 4, 16),
    foldTo3bet: clamp(58 * f, 40, 75),
    limp: clamp(14 * f, 4, 30),
    donk: clamp(6 * f, 2, 14),
    cbet,
    delayCbet: clamp(100 - cbet, 15, 55),
    af: clamp(2.6 / f, 1.2, 4.5),
    wtsd: clamp(27 * f, 18, 38),
    wsd: 51,
    checkRaise: clamp(9 * f, 4, 16),
  };
}

// Contagem padrão de outs por tipo de projeto já existe mais acima no arquivo (const DRAW_OUTS,
// usada também pelo motor de geração de mãos) — reaproveitada aqui em vez de redeclarada.

// Nomes de ação em inglês, usados apenas na cadeia de 35 indicadores e na prosa que a acompanha
// (mantém ACTION_VERDICT_PT intacto, pois é usado em outros pontos do app).
const ACTION_VERDICT_EN = { FOLD: "FOLD", CALL: "CALL", RAISE: "RAISE", CHECK: "CHECK", "ALL IN": "ALL-IN" };

function build35PointAnalysis(analysis, spot, fase) {
  const isBank = analysis.isBank;
  const e = isBank ? analysis.entry : null;
  const pe = !isBank ? spot.postflopEntry : null;
  const pop = populationBaseline(analysis.softFactor);
  const heroPos = isBank ? e.position : spot.heroPosition;
  const street = spot.street;
  const streetLabel = STREET_LABEL_PT[street] || street;
  const faseNarrativa = FASE_NARRATIVE_PT[fase] || "numa fase do torneio sem contexto de ICM detalhado, mas ainda assim com fichas em jogo valendo mais do que seu valor puro em BB";
  const potBB = spot.pot / spot.bb;
  const callBB = spot.callChips / spot.bb;
  const totalBB = potBB + callBB;
  const facingBet = !!spot.facingBet;
  const isPostflop = !isBank && street !== "PRE-FLOP";
  const heroStackBB = Number(spot.heroStackBB) || 0;

  const pts = [];
  const add = (label, text) => pts.push({ n: pts.length + 1, label, text });

  // 1. Stack Efetivo
  add("STACK EFETIVO", `${spot.heroStackBB} BB — ${heroStackBB <= 15 ? "stack curto: a decisão já é quase binária, fold ou comprometer tudo, com pouco espaço para manobra nas próximas streets" : heroStackBB <= 40 ? "stack moderado: ainda cabe alguma manobra sem comprometer tudo de uma vez" : "stack profundo: cabem várias rodadas de bet antes de qualquer comprometimento total"}`);

  // 2. Posição Relativa
  add("POSIÇÃO RELATIVA", `herói em ${heroPos} — ${["CO", "BTN"].includes(heroPos) ? "posição tardia: age por último ou quase, o que amplia o range jogável" : ["SB", "BB"].includes(heroPos) ? "posição de blind: tende a agir primeiro nas próximas streets, o que exige uma mão mais sólida para compensar essa desvantagem" : "posição inicial ou intermediária: ainda há muita gente para agir depois, o que exige mais força para abrir ou continuar"}`);

  // 3. PFR (Pre-Flop Raiser)
  let pfrText;
  if (isBank) {
    if (e.scenario === "RFI") pfrText = `ninguém abriu ainda — o herói é quem decide se assume a iniciativa nesta rodada`;
    else if (e.scenario === "FACING_3BET") pfrText = `o herói deu o open (foi o PFR) e ${spot.threebettorPos} respondeu com ${e.preflopLevel === 4 ? "4-bet" : "3-bet"} — a iniciativa original era do herói, mas o vilão assumiu o controle da mão`;
    else if (["OPEN_SHOVE"].includes(e.scenario)) pfrText = `o herói assume a iniciativa abrindo com um shove direto`;
    else pfrText = `${spot.openerPos || "um adversário"} deu o open da mão e tem a iniciativa; o herói decide como reagir`;
  } else if (pe && (pe.context === "3BET_POT" || pe.preflopLevel === 4)) {
    pfrText = pe.heroRole === "3BETTOR"
      ? `o herói foi o agressor pré-flop (3-bet/4-bet) e chega ao ${streetLabel} com a iniciativa da mão`
      : `o herói deu call na agressão pré-flop de ${pe.villainPos || "um adversário"}, que mantém a iniciativa até aqui`;
  } else {
    pfrText = `single raised pot (SRP) — quem deu o open pré-flop chega ao ${streetLabel} com a iniciativa, salvo indicação contrária na sequência de ações`;
  }
  add("PFR (INICIATIVA PRÉ-FLOP)", pfrText);

  // 4. Formato do Pote (SRP, 3-bet, 4-bet)
  let potFormatText;
  if (isBank) {
    if (e.scenario === "RFI") potFormatText = `ainda não houve nenhum raise — a decisão é abrir ou dar fold, pot no valor mínimo`;
    else if (e.scenario === "FACING_3BET") potFormatText = `${e.preflopLevel === 4 ? "pot de 4-bet" : "pot de 3-bet"} — ranges mais concentrados e mais fortes do que em um pot único, dos dois lados`;
    else if (["RESHOVE", "SQUEEZE", "MULTI_SHOVE"].includes(e.scenario)) potFormatText = `pot com pelo menos um re-raise envolvido (${e.scenario === "SQUEEZE" ? "squeeze" : e.scenario === "RESHOVE" ? "reshove" : "multi shove"}) — ranges mais estreitos do que um simples raise-call`;
    else potFormatText = `single raised pot (SRP) — um raise só, e a ação chega até o herói`;
  } else if (pe && (pe.context === "3BET_POT" || pe.preflopLevel === 4)) {
    potFormatText = `${pe.preflopLevel === 4 ? "pot de 4-bet" : "pot de 3-bet"} pago ainda no pré-flop — SPR mais raso e ranges mais concentrados do que em um pot único`;
  } else {
    potFormatText = `single raised pot (SRP) desde o pré-flop — proporção padrão entre pot e stack`;
  }
  add("FORMATO DO POTE", potFormatText);

  // 5. Contagem de Jogadores
  const participantCount = spot.participantCount || 2;
  const isOpenDecision = isBank && ["RFI", "OPEN_SHOVE"].includes(e.scenario); // ninguém decidiu ainda
  // depois do herói — os demais assentos (exceto os blinds) não entram no cálculo, então
  // "jogador ativo" seria enganoso aqui.
  let jogadoresText;
  if (isOpenDecision) {
    jogadoresText = `ainda falta gente para agir depois do herói — a régua de abertura já embute essa resistência (o modelo mede a força necessária principalmente contra a defesa dos blinds SB/BB, que são quem realmente fecha a ação, e não trata os outros assentos como oponentes ativos)`;
  } else if (participantCount > 2) {
    jogadoresText = `${participantCount} jogadores já confirmados na disputa deste pot — pot multiway: com mais gente brigando, a chance de alguém ter uma mão de fato forte sobe, então a exigência para continuar fica mais rígida do que contra um único adversário`;
  } else {
    jogadoresText = `2 jogadores confirmados na disputa deste pot — heads-up: apenas um adversário para vencer, o que permite jogar com um leque de mãos mais amplo do que em uma mão multiway`;
  }
  add("CONTAGEM DE JOGADORES", jogadoresText);

  // 6. Matriz de Abertura GTO (RFI)
  const rfiRef = positionOpenRangeText(heroPos);
  add("MATRIZ DE ABERTURA GTO (RFI)", rfiRef ? `a régua de abertura calibrada para ${heroPos} é top ${rfiRef.pct}% das mãos — ${rfiRef.text}; essa régua é a base de comparação usada para toda a análise que segue` : `posição sem régua de abertura própria calibrada (jogo pós-blind) — a comparação usa o range de continuação equivalente`);

  // 7. Índice de 3-Bet / 4-Bet (%)
  let threebetPct, threebetSource;
  if (isBank && e.scenario === "FACING_3BET") { threebetPct = THREEBET_WIDTH[spot.threebettorPos] || pop.threebet; threebetSource = `real deste spot (${spot.threebettorPos} deu 3-bet de fato)`; }
  else if (!isBank && pe && (pe.context === "3BET_POT" || pe.preflopLevel === 4) && pe.villainPos) { threebetPct = THREEBET_WIDTH[pe.villainPos] || pop.threebet; threebetSource = `real deste spot (${pe.villainPos} deu 3-bet de fato)`; }
  else { threebetPct = pop.threebet; threebetSource = "média populacional do campo escolhido, não uma estatística deste oponente específico"; }
  add("ÍNDICE DE 3-BET / 4-BET", `cerca de ${threebetPct.toFixed(1)}% — ${threebetSource}`);

  // 8. Fold to 3-Bet (%)
  add("FOLD TO 3-BET", `cerca de ${pop.foldTo3bet.toFixed(0)}% (média populacional do campo escolhido) — quanto mais alto, mais barato fica um bluff via 3-bet; quanto mais baixo, mais vale dar 3-bet só por valor`);

  // 9. Frequência de Limp (Limp-Call / Limp-Fold)
  let limpText;
  if (isBank && ["ISOLATE_LIMPERS", "LIMP_RAISE"].includes(e.scenario)) limpText = `${Math.max(1, participantCount - 1)} limper(s) já confirmado(s) neste spot — sinal direto de jogador passivo, o que abre espaço para isolar com um range mais amplo do que contra um raise`;
  else limpText = `cerca de ${pop.limp.toFixed(0)}% (média populacional) — jogador que dá limp costuma ser mais passivo e recreativo, então limp-call tende a superar limp-fold nesse perfil`;
  add("FREQUÊNCIA DE LIMP", limpText);

  // 10. Pot Odds
  add("POT ODDS", facingBet ? `dar call de ${callBB.toFixed(1)} BB em um pot de ${totalBB.toFixed(1)} BB depois do call exige vencer pelo menos ${analysis.alpha}% das vezes para não perder dinheiro no longo prazo` : `não se aplica agora — ninguém deu bet ainda nesta rodada de ação`);

  // 11. Implied Odds
  const sprNum = Number(analysis.spr);
  let impliedText;
  if (isBank) impliedText = `pouco relevante aqui — com o stack já comprometido nesta linha pré-flop, sobra pouco espaço para ganhar fichas extras em streets futuras`;
  else if (street === "RIVER") impliedText = `não existe — o river é a última carta, não há mais street para capturar valor extra`;
  else if (pe && DRAW_OUTS[pe.bucket] > 0) impliedText = sprNum > 3 ? `favoráveis: stack ainda profundo (SPR ${analysis.spr}) permite ganhar fichas extras nas próximas streets se o draw completar` : `limitadas: SPR ${analysis.spr} já é baixo, então sobra pouco stack extra para capturar mesmo completando o draw`;
  else impliedText = `pouco relevante com a mão atual — sem draw a completar, não há ganho extra relevante a projetar para as próximas streets`;
  add("IMPLIED ODDS", impliedText);

  // 12. Stack-to-Pot Ratio (SPR)
  add("STACK-TO-POT RATIO (SPR)", `${analysis.spr} — ${sprNum <= 1 ? "SPR muito baixo: a mão já está praticamente comprometida, qualquer bet relevante representa uma fração grande do stack" : sprNum <= 3 ? "SPR moderado: mão de valor real pode construir o pot com tranquilidade; mão marginal ainda tem espaço para escapar sem comprometer tudo" : "SPR alto: o stack ainda comporta várias rodadas de bet antes de qualquer comprometimento total"}`);

  // 13. Textura do Board (Dry vs. Wet)
  add("TEXTURA DO BOARD", isPostflop && analysis.boardTexture && analysis.boardTexture.category !== "PRÉ-FLOP" ? `${analysis.boardTexture.label} — a textura muda quais mãos o adversário consegue defender e pesa diretamente no tamanho ideal de bet` : `ainda não há flop nesta decisão — esse fator só entra em jogo a partir da próxima carta comunitária`);

  // 14. Nut Advantage
  let nutAdvText;
  if (isBank) nutAdvText = `no pré-flop, quem tem a mão mais forte no papel (herói ou vilão) ainda depende inteiramente das cartas — a nut advantage só se materializa depois do flop`;
  else if (pe && (pe.context === "3BET_POT" || pe.preflopLevel === 4)) nutAdvText = pe.heroRole === "3BETTOR" ? `o range de 3-bet do herói é mais concentrado em mãos de topo (pares altos, broadways), então tende a carregar mais combinações de nut neste board do que o range de quem só deu call` : `o range de quem deu 3-bet tende a concentrar mais combinações de nut do que o do herói, que só defendeu`;
  else nutAdvText = `${spot.openerPos || "quem deu o open"} tende a carregar mais combinações de topo do range (pares grandes, broadways) do que quem só defendeu — leve vantagem de nut a favor de quem teve a iniciativa`;
  add("NUT ADVANTAGE", nutAdvText);

  // 15. Range Advantage
  add("RANGE ADVANTAGE", isPostflop ? `considerando a textura (${analysis.boardTexture?.label || "—"}) e quem teve a iniciativa, o lado agressor costuma acertar esse board com mais frequência no geral — não é sobre a mão mais forte específica, é sobre qual range acerta mais vezes` : `ainda não há board para comparar os dois ranges na prática — no pré-flop a vantagem é só teórica, pela posição e pela ação`);

  // 16. Donk Bet (%)
  add("DONK BET", isPostflop && facingBet && pe && pe.heroRole !== "3BETTOR" ? `cerca de ${pop.donk.toFixed(0)}% (média populacional) — quando quem NÃO teve a iniciativa dá bet primeiro mesmo assim, é uma quebra de padrão que costuma sinalizar mão feita com medo de levar um check-raise, ou um bluff de quem não confia na continuação alheia` : `não se aplica nesta decisão — não há um bet fora do padrão de iniciativa para avaliar aqui`);

  // 17. Frequência de C-Bet
  add("FREQUÊNCIA DE C-BET", isPostflop ? `cerca de ${pop.cbet.toFixed(0)}% (média populacional) é o padrão de continuação de quem teve a iniciativa no flop — serve de referência para saber se o bet (ou a ausência dele) neste spot está dentro do esperado` : `ainda não há flop — a c-bet só existe a partir dessa street`);

  // 18. Índice de Delay C-Bet
  add("ÍNDICE DE DELAY C-BET", isPostflop && street !== "FLOP" ? `cerca de ${pop.delayCbet.toFixed(0)}% (média populacional) — deixar de dar bet no flop para atacar só no turn costuma indicar mão marginal buscando um turn mais seguro, ou um plano de manter o pot pequeno com uma mão feita mas vulnerável` : `não se aplica ainda — esse padrão só é observável a partir do turn, quando já existe um flop sem bet para comparar`);

  // 19. Sizing de Aposta
  let sizingText;
  if (analysis.sizing) sizingText = `tamanho recomendado: ${analysis.sizing.label.toLowerCase()}, cerca de ${analysis.sizing.bb} BB — ${analysis.sizing.reason}`;
  else if (facingBet) sizingText = `bet enfrentado de ${callBB.toFixed(1)} BB, ${((spot.callChips / Math.max(1, spot.pot)) * 100).toFixed(0)}% do pot antes do call — esse tamanho já define o quanto o herói precisa vencer para pagar`;
  else sizingText = `sem bet para dimensionar nesta decisão específica`;
  add("SIZING DE APOSTA", sizingText);

  // 20. Realização de Equidade (REq)
  add("REALIZAÇÃO DE EQUIDADE", ["CO", "BTN"].includes(heroPos) ? `favorável — agindo por último ou perto disso, o herói vê a informação do adversário antes de decidir, o que ajuda a realizar mais da equity bruta da mão` : `mais difícil — agindo cedo ou fora de posição, o herói decide com menos informação, o que tende a reduzir quanto da equity bruta a mão consegue de fato realizar até o showdown`);

  // 21. Contagem de Outs
  let outs = 0, outsText;
  if (isBank) outsText = `ainda não há board — outs só existem a partir do flop`;
  else if (pe && DRAW_OUTS[pe.bucket] > 0) { outs = DRAW_OUTS[pe.bucket]; outsText = `${outs} cartas ainda no deck completam o draw (${BUCKET_DESCRIPTION_PT[pe.bucket] || pe.bucket})`; }
  else outsText = `sem draw relevante a contar — a mão já está definida (feita ou sem chance real de melhorar)`;
  add("CONTAGEM DE OUTS", outsText);

  // 22. Regra dos 2 e 4
  add("REGRA DOS 2 E 4", outs > 0 && street !== "RIVER" ? `${outs} outs × ${street === "TURN" ? "2 (só falta uma carta)" : "4 (faltam duas cartas)"} ≈ ${(outs * (street === "TURN" ? 2 : 4)).toFixed(0)}% de chance estimada de completar até o fim da mão` : `não se aplica — sem outs relevantes a converter, ou já estamos no river e não sobra mais carta`);

  // 23. Índice de Variação de Board (card removal)
  add("VARIAÇÃO DE BOARD (CARD REMOVAL)", isPostflop && street !== "RIVER" ? `as cartas do herói e do board já removem algumas combinações do deck — isso muda ligeiramente a chance real de a próxima carta ajudar qualquer um dos dois lados, além da contagem bruta de outs` : isPostflop ? `sem mais cartas por vir — o board já está fechado, esse fator não influencia mais esta mão` : `ainda não há board para remover combinações — esse fator só entra em jogo a partir do flop`);

  // 24. Fold Equity (FE)
  const mdfNum = Number(analysis.mdf);
  add("FOLD EQUITY", ["RAISE", "ALL IN"].includes(bucketOf(analysis.exploitAction)) ? `dando bet/raise aqui, o adversário precisa continuar em pelo menos ${analysis.mdf}% das vezes (MDF) para não sangrar valor para um bluff — abaixo disso, parte do lucro desta linha vem simplesmente do fold do vilão, não só do showdown` : `não é o fator decisivo nesta ação específica — o herói está reagindo, não gerando pressão de fold sobre o adversário agora`);

  // 25. Double / Triple Barrel
  let barrelText;
  if (isBank || street === "PRE-FLOP") barrelText = `ainda não se aplica — barrel é sobre manter a agressão nas streets pós-flop`;
  else if (pe && pe.heroRole === "3BETTOR" || (!pe && spot.openerPos === heroPos)) barrelText = street === "FLOP" ? `primeiro bet da sequência (c-bet) — ainda não é um barrel, mas define se há continuidade nas próximas streets` : `${street === "TURN" ? "segunda" : "terceira"} rodada de agressão do mesmo jogador (${street === "TURN" ? "double barrel" : "triple barrel"}) — precisa de um motivo real (draw, bluff com equity, ou valor) para continuar sendo lucrativa, não só inércia`;
  else barrelText = `o herói não teve a iniciativa nas streets anteriores — não há uma sequência de barrels própria a avaliar aqui`;
  add("DOUBLE / TRIPLE BARREL", barrelText);

  // 26. Aggression Factor (AF)
  add("AGGRESSION FACTOR", `cerca de ${pop.af.toFixed(1)} (média populacional: bets+raises ÷ calls) — quanto mais alto, mais o perfil típico desse campo dá bet e raise em vez de só dar call`);

  // 27. Classificação Absoluta da Mão
  let handClassText;
  if (isBank) handClassText = `${e.handType}, top ${analysis.percentile}% das mãos possíveis em ${heroPos} — ${strengthLabel(analysis.percentile)}`;
  else {
    const cat = evalHand([...spot.heroCards, ...spot.board]).category;
    const desc = pe ? (BUCKET_DESCRIPTION_PT[pe.bucket] || "mão a definir") : CATEGORY_DESCRIPTION_PT[cat];
    const classe = cat >= 5 ? "próxima do nut do board" : cat >= 1 || (pe && DRAW_OUTS[pe.bucket] > 0) ? "bluff-catcher / mão média com algum valor de showdown" : "air — sem valor de showdown pronto";
    handClassText = `${desc} — classificação: ${classe}`;
  }
  add("CLASSIFICAÇÃO ABSOLUTA DA MÃO", handClassText);

  // 28. Blockers
  const heroRanks = (spot.heroCards || []).map((c) => c.r || RANKS[c.v - 2]);
  const hasAce = heroRanks.includes("A");
  const hasBroadway = heroRanks.some((r) => ["A", "K", "Q", "J", "T"].includes(r));
  add("BLOCKERS", hasAce ? `o herói segura um Ace — reduz a chance do adversário ter AA ou um Ax forte no range dele, um blocker relevante para qualquer leitura de bluff ou de valor` : hasBroadway ? `carta(s) alta(s) na mão do herói bloqueia(m) algumas combinações de broadway do range do adversário, com efeito discreto mas real na frequência real desse range` : `sem carta relevante como blocker nesta mão específica — nenhum efeito de remoção digno de nota sobre o range do adversário`);

  // 29. Alpha do Blefe (α)
  add("ALPHA DO BLEFE (α)", facingBet ? `α = ${analysis.alpha}% — é a frequência mínima de fold que o adversário precisa ceder para um bluff dele ser lucrativo nesse tamanho de bet; é o espelho exato da pot odds vista do lado de quem apostou` : ["RAISE", "ALL IN"].includes(bucketOf(analysis.exploitAction)) ? `se este bet/raise for um bluff puro, precisa que o adversário desse fold pelo menos ~${analysis.mdf}% das vezes para se pagar sozinho, sem depender do showdown` : `não se aplica de forma direta nesta ação — o herói não está dando bet/blefando neste momento`);

  // 30. Minimum Defense Frequency (MDF)
  add("MINIMUM DEFENSE FREQUENCY (MDF)", facingBet ? `${analysis.mdf}% — é a frequência mínima com que o RANGE do herói (não esta mão isolada) precisa continuar contra esse bet para não abrir um bluff sempre lucrativo para o adversário` : `não se aplica agora — MDF só existe do lado de quem está defendendo um bet`);

  // 31. Frequência de Check-Raise
  add("FREQUÊNCIA DE CHECK-RAISE", isPostflop && !facingBet ? `cerca de ${pop.checkRaise.toFixed(0)}% (média populacional) — é o equilíbrio esperado entre dar check para ceder a iniciativa de verdade e dar check para depois responder com um raise, protegendo o range de check contra ser explorado` : `não se aplica nesta decisão específica — check-raise só é uma opção para quem já deu check e ainda está na mão`);

  // 32. WTSD (Went to Showdown %)
  add("WTSD (WENT TO SHOWDOWN)", `cerca de ${pop.wtsd.toFixed(0)}% (média populacional) — mostra a propensão geral desse perfil de campo a dar call até o final da mão em vez de dar fold pelo caminho`);

  // 33. W$SD (Won Money at Showdown %)
  add("W$SD (WON $ AT SHOWDOWN)", `em torno de ${pop.wsd.toFixed(0)}% (média populacional, pouco sensível ao perfil de campo) — sinaliza que quem chega ao showdown tende a ter, em média, uma mão real, não um bluff puro sem equity`);

  // 34. EV (Valor Esperado)
  const evNum = parseFloat(analysis.evBB);
  add("EV (VALOR ESPERADO)", evNum >= 0 ? `+${analysis.evBB} BB de ganho médio no longo prazo, toda vez que esse exato cenário se repetir — é essa média ao longo de muitas mãos, não o resultado de uma mão isolada, que comprova a decisão` : `${analysis.evBB} BB — mesmo sendo a melhor opção disponível, o cenário já era desfavorável para o herói antes mesmo de agir; a linha recomendada é a que perde menos, não a que garante lucro`);

  // 35. Índice de Exploit vs. GTO
  add("EXPLOIT VS. GTO", `desvio motivado por ${analysis.dominantLabel === "PRESSÃO DE TORNEIO" ? `pressão de torneio (ICM) — o torneio está ${faseNarrativa}` : "ajuste populacional (perfil de campo escolhido)"}; ação de equilíbrio (GTO/baseline): ${ACTION_VERDICT_EN[analysis.baselineAction] || analysis.baselineAction}; ação recomendada aqui (exploit): ${ACTION_VERDICT_EN[analysis.exploitAction] || analysis.exploitAction}`);

  return pts;
}

// Prosa didática, em sequência, cobrindo os 35 pontos — agrupados em parágrafos temáticos pra
// ler como um raciocínio corrido (não como uma lista crua), mas sem pular nenhum indicador.
function build35PointExplanation(points, analysis, decision) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const verbo = ACTION_VERDICT_EN[analysis.exploitAction] || analysis.exploitAction;
  const g = (n) => points[n - 1].text;
  const p1 = `${cap(g(1))}. ${cap(g(2))}. ${cap(g(3))}. ${cap(g(4))}. ${cap(g(5))}.`;
  const p2 = `Como referência, ${g(6)}. O nível de agressão típico do campo: 3-bet/4-bet ${g(7)}; fold to 3-bet ${g(8)}; limp ${g(9)}.`;
  const p3 = `Na matemática direta da mão: ${g(10)}. Já pensando à frente, implied odds ${g(11)}, e o SPR ${g(12)}.`;
  const p4 = `Sobre o board, ${g(13)}. Em termos de vantagem de range, ${g(14)}; e ${g(15)}. Do lado do comportamento esperado, donk bet ${g(16)}, c-bet ${g(17)} e delay c-bet ${g(18)}.`;
  const p5 = `Na execução: ${g(19)}. A equity realization tende a ficar ${g(20)}. Quanto ao draw, ${g(21)}, e pela regra dos 2 e 4, ${g(22)}. O card removal — ${g(23)}.`;
  const p6 = `Sobre pressão e defesa: fold equity ${g(24)}; em relação a manter a agressão, ${g(25)}; e o perfil geral de agressão do campo (AF) fica em ${g(26)}.`;
  const p7 = `A mão em si: ${g(27)}. Como blocker, ${g(28)}. O alpha do bluff ${g(29)}, e a MDF ${g(30)}. Check-raise ${g(31)}; WTSD ${g(32)}; W$SD ${g(33)}.`;
  const p8 = `Somando tudo: o EV ${g(34)}. O ${g(35)}. Diante de todos esses fatores, a decisão recomendada é ${verbo}.`;
  // Fecha o raciocínio com o veredito real: o que o herói de fato escolheu nesta mão e a
  // graduação que essa escolha recebeu (mesma linguagem do card AGUARDANDO AÇÃO) — liga a
  // explicação didática à decisão realmente tomada, não só à recomendação teórica.
  const gradeTag = decision && !decision.timeout ? GRADE_TAG_EN[decision.grade] : null;
  let p9 = "";
  if (gradeTag) {
    const normalizedUserAction = bucketOf(decision.action) === "ALLIN" ? "ALL IN" : bucketOf(decision.action);
    const userActionEN = ACTION_VERDICT_EN[normalizedUserAction] || normalizedUserAction;
    p9 = userActionEN === verbo
      ? ` Na prática, o herói escolheu ${userActionEN} — a mesma ação recomendada aqui: ${gradeTag}.`
      : ` Na prática, o herói escolheu ${userActionEN} em vez de ${verbo} — resultado desta decisão: ${gradeTag}.`;
  }
  return [p1, p2, p3, p4, p5, p6, p7, p8].join(" ") + p9;
}

// Resumo numerado — mesmo formato de linhas "N. RÓTULO: valor" já usado no app, agora cobrindo
// os 35 indicadores completos em vez de um subconjunto.
function build35PointSummaryLines(points) {
  return points.map((pt) => `${pt.n}. ${pt.label}: ${pt.text}`);
}

function EvaluationPanel({ title, color, action, summary, explanation, lines, revealed }) {
  const c = revealed ? color : "#4B5563";
  return (
    <div className="rounded-md p-3 flex flex-col gap-2 text-left" style={{ border: `1.5px solid ${c}`, opacity: revealed ? 1 : 0.55, textTransform: "uppercase" }}>
      <div style={{ fontSize: 11, color: c, fontWeight: 900 }}>{title}</div>
      <div style={{ fontSize: 11, color: revealed ? "#FDE047" : "#6B7280", fontWeight: 800, borderLeft: `2px solid ${revealed ? "#FACC15" : "#4B5563"}`, paddingLeft: 8 }}>
        {revealed ? summary : "Aguardando sua decisão..."}
      </div>
      <div style={{ fontSize: 11, fontWeight: 900, color: revealed ? "#22C55E" : "#6B7280", background: revealed ? "rgba(34,197,94,0.08)" : "rgba(107,114,128,0.08)", border: `1px solid ${revealed ? "rgba(34,197,94,0.2)" : "rgba(107,114,128,0.2)"}`, borderRadius: 4, padding: "6px 8px" }}>
        AÇÃO SUGERIDA: {revealed ? action : "---"}
      </div>
      <div style={{ fontSize: 11, color: revealed ? "#D1D5DB" : "#6B7280", lineHeight: 1.6 }}>
        {revealed ? explanation : "Aguardando sua decisão para gerar a explicação..."}
      </div>
      <div style={{ fontSize: 11, color: revealed ? "#D1D5DB" : "#6B7280", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
        {revealed ? "RESUMO:\n" + lines.join("\n") : "RESUMO:\nAguardando sua decisão..."}
      </div>
    </div>
  );
}

// ---------- App ----------
// ---------- Integração de IA (BYOK — chave própria do usuário, 3 provedores) ----------
const AI_PROVIDERS = [
  { key: "openai", label: "OPENAI (GPT)" },
  { key: "anthropic", label: "ANTHROPIC (CLAUDE)" },
  { key: "google", label: "GOOGLE (GEMINI)" },
];

const appStorage = {
  async get(key) {
    if (typeof window === "undefined") return null;
    if (window.storage && typeof window.storage.get === "function") return window.storage.get(key, false);
    const value = window.localStorage ? window.localStorage.getItem(key) : null;
    return value == null ? null : { value };
  },
  async set(key, value) {
    if (typeof window === "undefined") return;
    if (window.storage && typeof window.storage.set === "function") return window.storage.set(key, value, false);
    if (window.localStorage) window.localStorage.setItem(key, value);
  },
};

const STRUCTURE_PROMPT = `Você é um assistente que analisa fotos de estruturas de torneios de poker. A partir da imagem enviada, extraia as informações e devolva SOMENTE um objeto JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:

{
  "modalidade": "regular" | "turbo" | "bounty",
  "field": 50 | 100 | 250 | 500 | 1000,
  "tableSize": 6 | 8 | 9 | 10,
  "observacoes": "resumo curto em português do que foi identificado (níveis de blind, ante, stack inicial, duração dos níveis, premiação se visível)"
}

Regras:
- "modalidade": níveis subindo rápido (5-10 min) = "turbo"; menção a bounty/recompensa por eliminação = "bounty"; caso contrário "regular".
- "field": estime pelo número de mesas ou inscritos, arredondando para a opção mais próxima entre 50, 100, 250, 500 ou 1000.
- "tableSize": jogadores por mesa (6, 8, 9 ou 10); use 9 se não houver essa informação.
- Se algo não estiver visível, use o valor mais razoável e explique a limitação em "observacoes".

Responda apenas com o JSON, nada mais.`;

// Parser de JSON 100% blindado contra respostas malformadas de IA — NUNCA lança exceção.
// Em vez disso, devolve um objeto com `__parseError: true` quando não consegue interpretar o
// texto de nenhuma forma, pra quem chamar decidir como tratar isso sem try/catch obrigatório
// nem risco de travar a interface com uma promise rejeitada por erro de sintaxe.
function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { __parseError: true, __reason: "resposta vazia" };
  }
  const tryParse = (candidate) => {
    try { return { ok: true, value: JSON.parse(candidate) }; } catch { return { ok: false }; }
  };

  // 1) Remove blocos de código markdown (```json ... ``` ou ``` ... ```), preservando o miolo.
  let cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
  if (!cleaned) cleaned = text.trim();

  // 2) Tenta o parse direto — cobre o caso feliz de a IA responder só com o JSON.
  let attempt = tryParse(cleaned);
  if (attempt.ok) return attempt.value;

  // 3) Isola o maior bloco {...} do texto (cobre respostas com preâmbulo/explicação ao redor).
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    attempt = tryParse(braceMatch[0]);
    if (attempt.ok) return attempt.value;

    // 4) Correções comuns de resposta de IA: vírgula sobrando antes de "}"/"]" e aspas simples
    // em chaves/valores (JSON exige aspas duplas).
    const repaired = braceMatch[0]
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    attempt = tryParse(repaired);
    if (attempt.ok) return attempt.value;
  }

  // 5) Nada funcionou: devolve um objeto seguro em vez de lançar exceção.
  return { __parseError: true, __reason: "não foi possível interpretar a resposta como JSON", __raw: text.slice(0, 500) };
}

async function callOpenAI(apiKey, prompt, image, parseMode) {
  const content = [{ type: "text", text: prompt }];
  if (image) content.push({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o", max_tokens: 700, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`OPENAI HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Resposta vazia da OpenAI");
  return parseMode === "json" ? extractJson(text) : text;
}

async function callAnthropic(apiKey, prompt, image, parseMode) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } });
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 700, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`ANTHROPIC HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Resposta vazia da Anthropic");
  return parseMode === "json" ? extractJson(text) : text;
}

async function callGemini(apiKey, prompt, image, parseMode) {
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.mediaType, data: image.base64 } });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!res.ok) throw new Error(`GEMINI HTTP ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  if (!text) throw new Error("Resposta vazia do Gemini");
  return parseMode === "json" ? extractJson(text) : text;
}

const AI_CALLERS = { openai: callOpenAI, anthropic: callAnthropic, google: callGemini };

// ============================================================
// GERAÇÃO DE SPOTS POR IA (BETA) — opcional, desligada por padrão, exige provedor+chave já
// configurados em INTEGRAR IA.
// Regra inegociável (AGENTS.md: "nunca derive a ação correta... de IA/índice/frequência"): a IA
// NUNCA decide a ação certa, nunca inventa cartas, EV ou textura de board. Ela só ESCOLHE, dentro
// das mesmas enumerações legais que o banco local já usa (posição, cenário, tipo de mão ou bucket
// de força, profundidade de stack), qual combinação visitar a seguir — a mesma tabela de decisão
// determinística do motor estratégico (a mesma que roda pra qualquer spot do banco local) continua
// 100% responsável pelo resto: gerar as cartas reais, calcular pot odds/EV e julgar a decisão do
// usuário. Ver selectSessionVariation (cfg.forcedEntry) — o ponto exato onde isso se conecta.
// Em caso de qualquer falha (rede, JSON inválido, valor fora da enumeração, timeout), o app cai
// de volta pro gerador local em silêncio — a sessão nunca trava esperando a IA.
function computeAiSelectionDomain(cfg, faseKey, streetKey) {
  if (streetKey === "PRE-FLOP") {
    let bank = filterPreflopBankByPreset(selectGeneralSpots(faseKey, "PRE-FLOP"), cfg.preset);
    if (!cfg.preset) bank = filterBankByHeroPosition(bank, cfg.heroPositionFilter);
    bank = filterBankByTableSize(bank, cfg.tableSize);
    if (!bank.length) return null;
    return {
      street: "PRE-FLOP",
      positions: [...new Set(bank.map((e) => e.position))],
      scenarios: [...new Set(bank.map((e) => e.scenario))],
      handTypes: HAND_TYPES.map((h) => h.type),
    };
  }
  let bank = filterPostflopBankByPreset(selectGeneralSpots(faseKey, streetKey), cfg.preset);
  if (!cfg.preset) bank = filterBankByHeroPosition(bank, cfg.heroPositionFilter);
  bank = filterBankByTableSize(bank, cfg.tableSize);
  if (!bank.length) return null;
  const buckets = streetKey === "RIVER" ? RIVER_BUCKETS : streetKey === "TURN" ? TURN_BUCKETS : FLOP_BUCKETS;
  return {
    street: streetKey,
    positions: [...new Set(bank.map((e) => e.position))],
    scenarios: [...new Set(bank.map((e) => e.scenario))],
    buckets,
    sprLevels: POSTFLOP_SPR,
  };
}
function buildAiSpotPrompt(domain, faseKey, recentSummary) {
  const base = `Você está escolhendo o PRÓXIMO cenário de treino de poker (torneio No-Limit Hold'em) para um app de treino, fase de torneio "${faseKey}". Sua ÚNICA tarefa é ESCOLHER valores dentro das listas abaixo, priorizando variedade real (evite repetir o que já apareceu recentemente) — nunca escreva um valor fora das listas, e nunca calcule a ação correta (isso é feito por outro motor determinístico do app, você não participa disso).`;
  const fields = domain.street === "PRE-FLOP"
    ? `Responda SOMENTE em JSON estrito, sem texto fora do JSON: {"position": <uma destas: ${domain.positions.join(", ")}>, "scenario": <uma destas: ${domain.scenarios.join(", ")}>, "handType": <um destes tipos de mão pré-flop: ${domain.handTypes.join(",")}>, "stackBB": <número entre 8 e 200>}`
    : `Responda SOMENTE em JSON estrito, sem texto fora do JSON: {"position": <uma destas: ${domain.positions.join(", ")}>, "scenario": <uma destas: ${domain.scenarios.join(", ")}>, "bucket": <um destes: ${domain.buckets.join(", ")}>, "spr": <um destes: ${domain.sprLevels.join(", ")}>, "participantCount": <2, 3 ou 4>, "stackBB": <número entre 8 e 200>}`;
  const recent = recentSummary ? `\nEvite repetir os cenários mais recentes desta sessão: ${recentSummary}.` : "";
  return `${base}${recent}\n${fields}`;
}
function validateAiSpotParams(raw, domain) {
  if (!raw || typeof raw !== "object" || raw.__parseError) return null;
  if (!domain.positions.includes(raw.position)) return null;
  if (!domain.scenarios.includes(raw.scenario)) return null;
  const stackNum = Number(raw.stackBB);
  const stackBB = Number.isFinite(stackNum) ? Math.min(200, Math.max(8, Math.round(stackNum))) : null;
  if (domain.street === "PRE-FLOP") {
    if (!domain.handTypes.includes(raw.handType)) return null;
    return { position: raw.position, scenario: raw.scenario, handType: raw.handType, stackBB };
  }
  if (!domain.buckets.includes(raw.bucket)) return null;
  if (!domain.sprLevels.includes(raw.spr)) return null;
  const participantCount = [2, 3, 4].includes(Number(raw.participantCount)) ? Number(raw.participantCount) : 2;
  return { position: raw.position, scenario: raw.scenario, bucket: raw.bucket, spr: raw.spr, participantCount, stackBB };
}
function buildAiForcedEntry(params, faseKey, streetKey) {
  const id = `AI|${faseKey}|${streetKey}|${hashStr(JSON.stringify(params))}|${Date.now()}`;
  const stackRange = params.stackBB != null ? [Math.max(2, params.stackBB - 2), params.stackBB + 2] : undefined;
  if (streetKey === "PRE-FLOP") {
    return { id, position: params.position, scenario: params.scenario, handType: params.handType, variant: "AI", stackRange };
  }
  return {
    id, position: params.position, scenario: params.scenario, bucket: params.bucket, spr: params.spr,
    variant: "AI", participantCount: params.participantCount || 2, preflopLevel: 2, stackRange,
  };
}
// Ponto único de entrada usado pelo componente (ver useEffect de pré-busca): tenta gerar+validar
// uma entrada forçada; qualquer problema (rede, parsing, valor fora da enumeração) devolve null
// em vez de lançar exceção — o chamador cai pro gerador local automaticamente.
async function fetchAiForcedEntry({ provider, apiKey, cfg, faseKey, streetKey, recentSummary }) {
  const domain = computeAiSelectionDomain(cfg, faseKey, streetKey);
  if (!domain) return null;
  const caller = AI_CALLERS[provider];
  if (!caller || !apiKey) return null;
  const prompt = buildAiSpotPrompt(domain, faseKey, recentSummary);
  const raw = await caller(apiKey, prompt, null, "json");
  const params = validateAiSpotParams(raw, domain);
  if (!params) return null;
  return buildAiForcedEntry(params, faseKey, streetKey);
}

const TRAINING_BUTTON_NAMES = TRAINING_PRESETS.map((p) => `"${p.label}" (grupo ${p.group})`).join(", ");
const REPORT_PROMPT_PREFIX = `Você é um "leak seeker" — um caça-vazamentos de poker — analisando o histórico de treino de um jogador recreativo de torneios dentro do app STACKUP HOLD'EM PRO. A seguir está um resumo com o total de spots treinados, taxa de acerto, EV médio das decisões, e as últimas decisões (fase do torneio, street, posição, tipo de mão, ação escolhida, ação correta, se acertou ou errou, EV da linha correta).

O app tem os seguintes botões de treino específico disponíveis, cada um filtrando um cenário particular: ${TRAINING_BUTTON_NAMES}.

Escreva um relatório curto, direto e didático em português, no formato de um verdadeiro caça-vazamentos:
1. LEAKS ENCONTRADOS: aponte os 2-3 padrões de erro mais claros nos dados — seja específico sobre posição, street e tipo de cenário (por exemplo "erra a maioria das defesas de BB contra abertura de posição tardia" ou "força demais o pagamento em projetos de sequência no river"). Quando der pra perceber pelos dados, estime o quanto isso está custando em EV.
2. PONTOS FORTES: onde o jogador mais acerta, rapidamente.
3. TREINO RECOMENDADO: para cada leak encontrado, indique O BOTÃO EXATO que a pessoa deveria clicar no app pra treinar aquilo especificamente — escolha entre os botões listados acima, seja concreto, nunca genérico.

Seja direto, sem jargão técnico excessivo, como um treinador experiente dando feedback rápido a um aluno. No máximo 220 palavras.

DADOS:
`;

// Semente de RNG pro torneio — função de módulo (fora do componente) de propósito: isolar as
// chamadas impuras (Date.now/Math.random) longe do corpo do componente evita qualquer ambiguidade
// da análise estática do linter sobre "chamada durante o render".
function generateTorneioSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}


function StackupOpeningScreen({ onEnter }) {
  const [drawer,setDrawer]=useState(null);
  const [language,setLanguage]=useState("pt");
  const [draftLanguage,setDraftLanguage]=useState("pt");
  const [phone,setPhone]=useState("");
  const [otpSent,setOtpSent]=useState(false);
  const [otp,setOtp]=useState(["","","",""]);
  const [keepLogged,setKeepLogged]=useState(true);
  const toggle=(id)=>setDrawer(v=>v===id?null:id);
  const Icon=({type,className=""})=>{
    const common={viewBox:"0 0 64 64",className,fill:"none",stroke:"currentColor",strokeWidth:"2.2",strokeLinecap:"round",strokeLinejoin:"round"};
    if(type==="globe") return <svg {...common}><circle cx="32" cy="32" r="24"/><path d="M8 32h48M32 8c8 7 12 15 12 24S40 49 32 56M32 8c-8 7-12 15-12 24s4 17 12 24M13 20h38M13 44h38"/></svg>;
    if(type==="finger") return <svg {...common}><path d="M32 7C18 7 8 17 8 31m48 0C56 17 46 7 32 7M14 38c0 8-2 13-6 18m42-18c0 8 2 13 6 18M20 31c0-7 5-12 12-12s12 5 12 12c0 13-4 22-11 28M26 32c0-4 2-6 6-6s6 2 6 6c0 10-2 18-7 25M20 48c3-5 4-10 4-16"/></svg>;
    if(type==="wa") return <svg {...common}><path d="M12 54l4-12a22 22 0 1 1 8 8z"/><path d="M24 20c-3 2-3 6 0 11 4 7 10 11 16 12 4 1 7-1 8-4l-7-4-4 3c-5-2-8-5-11-10l3-3z"/></svg>;
    return <svg {...common} viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>;
  };
  const Card=({id,icon,title,sub})=><>
    <button className={"gold-card "+(drawer===id?"active":"")} onClick={()=>toggle(id)}>
      <span className="gold-icon"><Icon type={icon}/></span>
      <span className="gold-copy"><strong>{title}</strong><small>{sub}</small></span>
      <span className="gold-water"><Icon type={icon}/></span>
      <span className={"gold-chevron "+(drawer===id?"up":"")}><Icon type="chev"/></span>
    </button>
  </>;
  const Drawer=({id,children})=><div className={"gold-drawer "+(drawer===id?"open":"")}><div><div className="gold-panel">{children}</div></div></div>;
  return <div className="gold-login"><style>{`
@import url('https://fonts.googleapis.com/css2?family=Viga&display=swap');
.gold-login{min-height:100vh;background:#020202;color:#fff;font-family:Arial,sans-serif;overflow-x:hidden}.gold-shell{width:min(100%,430px);margin:auto;padding:0 14px 24px;background:radial-gradient(ellipse at 50% 12%,#17140d 0,#080807 38%,#020202 74%)}
.gold-hero{height:430px;margin:0 -14px 12px;position:relative;overflow:hidden;background:radial-gradient(circle at 50% 28%,#1b1811 0,#080807 45%,#020202 80%);border-bottom:1px solid #3d3320}.gold-hero:after{content:"";position:absolute;inset:0;z-index:2;background:linear-gradient(180deg,transparent 48%,rgba(0,0,0,.14) 64%,rgba(2,2,2,.86) 91%,#020202 100%),radial-gradient(ellipse at 50% 77%,rgba(213,170,82,.08),transparent 48%);pointer-events:none}
.aces{position:absolute;z-index:0;left:-18px;right:-18px;top:10px;height:205px;display:flex;justify-content:center;filter:blur(.45px) brightness(.55) saturate(.72);opacity:.72}.ace{position:relative;width:112px;height:174px;border:1px solid #6e5a32;border-radius:13px;background:linear-gradient(145deg,#151513,#050505);box-shadow:inset 0 0 20px #000,0 5px 18px #000;padding:11px;color:#d5aa52;font:400 25px Viga,sans-serif;transform-origin:50% 100%}.ace span{display:block;line-height:.88}.ace:nth-child(1){transform:rotate(-20deg) translate(22px,32px)}.ace:nth-child(2){transform:rotate(-7deg)}.ace:nth-child(3){transform:rotate(7deg)}.ace:nth-child(4){transform:rotate(20deg) translate(-22px,32px)}
.chips{position:absolute;z-index:1;bottom:105px;width:110px;height:90px;opacity:.58;filter:blur(.35px) brightness(.62)}.chips.left{left:-9px}.chips.right{right:-9px}.chips:before,.chips:after{content:"";position:absolute;left:0;right:0;height:18px;border:2px solid #6d572d;border-radius:50%;background:radial-gradient(ellipse at 50% 30%,#51452c 0,#201d16 38%,#070707 72%);box-shadow:inset 0 2px #b38c42,0 14px 0 #111,0 16px 0 #70582e,0 28px 0 #171612,0 30px 0 #806534,0 42px 0 #0d0d0c}.chips:after{left:37px;top:9px;right:-18px}
.stk{position:absolute;z-index:3;top:7px;left:50%;transform:translateX(-50%);width:238px;height:238px;border-radius:50%;background:radial-gradient(circle at 48% 36%,#2b271e,#0c0c0a 56%,#020202 75%);border:11px solid #111;box-shadow:0 0 0 2px #d5aa52,0 0 0 8px #11100c,inset 0 0 0 3px #b98935,inset 0 0 34px #000,0 8px 28px #000c,0 0 12px #b989351f}.stk{isolation:isolate}.stk:before{content:"♠";position:absolute;inset:25px;display:grid;place-items:center;font:900 134px Georgia;background:linear-gradient(135deg,#f2d995,#d5aa52 31%,#8a6329 51%,#e8c675 72%,#60431e);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 4px 2px #000)}.stk:after{content:"STK";position:absolute;inset:0;display:grid;place-items:center;font:400 57px Viga,sans-serif;letter-spacing:-5px;background:linear-gradient(180deg,#f2d995,#d5aa52 27%,#b98935 49%,#e8c675 68%,#60431e);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 3px 1px #000)}
.gold-brand{position:absolute;z-index:4;left:0;right:0;bottom:12px;text-align:center}.gold-brand b{display:block;font-family:Viga,sans-serif;line-height:.9;filter:drop-shadow(0 4px 2px #000)}.gold-stack{font-size:48px;background:linear-gradient(180deg,#fff,#e3e4e6 22%,#bfc1c5 43%,#85888e 61%,#e5e6e8 79%,#4f5257);-webkit-background-clip:text;background-clip:text;color:transparent}.gold-hold{font-size:35px;background:linear-gradient(180deg,#f2d995,#d5aa52 38%,#b98935 69%,#765022);-webkit-background-clip:text;background-clip:text;color:transparent}.gold-grinder{font-size:58px;background:linear-gradient(180deg,#e1bc6a,#b98935 34%,#8a6329 59%,#5e401c 78%,#c99b45);-webkit-background-clip:text;background-clip:text;color:transparent}.gold-brand small{display:block;margin-top:8px;color:#d7d8da;font-size:9px;letter-spacing:.25em;font-weight:700}
.gold-card{position:relative;width:100%;height:84px;margin:0 0 9px;padding:12px 43px 12px 16px;border:1px solid rgba(222,193,122,.62);border-radius:17px;background:linear-gradient(135deg,rgba(26,23,17,.72),rgba(3,3,3,.96));box-shadow:inset 0 1px rgba(255,245,210,.08),0 10px 24px #000c,0 0 9px #d5aa520d;backdrop-filter:blur(16px) saturate(115%);color:#fff;display:grid;grid-template-columns:48px 1fr;gap:13px;align-items:center;text-align:left;overflow:hidden}.gold-card:after{content:"";position:absolute;left:20px;top:-1px;width:38px;height:1px;background:linear-gradient(90deg,transparent,#f2d995,transparent);box-shadow:0 0 7px #d5aa5288}.gold-card.active{border-color:#f2d995}.gold-icon{width:38px;height:38px;color:#e6c879;z-index:2}.gold-icon svg,.gold-water svg,.gold-chevron svg{width:100%;height:100%}.gold-copy{z-index:2}.gold-copy strong{display:block;font:400 17px Viga,sans-serif;color:#e3c170}.gold-copy small{display:block;margin-top:5px;color:#aaa69c;font-size:10px}.gold-water{position:absolute;width:116px;height:116px;right:-21px;top:-15px;color:#d5aa52;opacity:.05}.gold-chevron{position:absolute;right:14px;top:34px;width:18px;height:18px;color:#f2d995;transition:.24s}.gold-chevron.up{transform:rotate(180deg)}
.gold-drawer{display:grid;grid-template-rows:0fr;opacity:0;transform:translateY(-5px);margin:-14px 0 10px;transition:grid-template-rows .24s,opacity .2s,transform .24s}.gold-drawer.open{grid-template-rows:1fr;opacity:1;transform:none}.gold-drawer>div{overflow:hidden}.gold-panel{padding:18px 11px 11px;border:1px solid #79653b;border-top:0;border-radius:0 0 15px 15px;background:linear-gradient(#17140ef7,#050505fb);box-shadow:0 14px 26px #000a}.gold-grid,.gold-actions{display:grid;gap:8px}.gold-two,.gold-actions{grid-template-columns:1fr 1fr}.gold-choice,.gold-action{min-height:47px;border:1px solid #665839;border-radius:10px;background:linear-gradient(135deg,#171611,#080808);color:#eee;font:400 10.5px Viga,sans-serif}.gold-choice.selected,.gold-action.primary{border-color:#d5aa52;background:linear-gradient(135deg,#302719,#171109);box-shadow:inset 0 1px #fff2,0 5px 14px #0008}.gold-auth{display:grid;grid-template-columns:1fr 1fr;gap:8px}.gold-auth button{display:grid;grid-template-columns:30px 1fr;gap:8px;align-items:center;text-align:left;padding:8px}.gold-auth svg{width:27px;color:#dec17a}.gold-auth small{display:block;color:#8f8b82;font:500 7.5px Arial;margin-top:3px}.gold-google{font:900 23px Arial;color:#d7d8da}.gold-phone{display:grid;grid-template-columns:83px 1fr;gap:8px}.gold-country,.gold-field{height:47px;border:1px solid #665839;border-radius:10px;background:#070707;color:#fff}.gold-country{display:grid;place-items:center;font:400 11px Viga}.gold-field{width:100%;padding:0 12px;outline:none}.gold-send{width:100%;margin-top:8px}.gold-otps{display:flex;gap:8px;margin-top:10px}.gold-otp{width:48px;height:50px;border:1px solid #665839;border-radius:10px;background:#070707;color:#fff;text-align:center;font-size:20px;outline:none}.gold-keep{display:flex;gap:8px;margin:11px 1px;font:400 9.5px Viga}.gold-keep input{accent-color:#b98935}.gold-actions{margin-top:9px}.gold-foot{display:flex;align-items:center;gap:10px;justify-content:center;padding:11px 0 3px;color:#d5aa52;font-size:7.5px;letter-spacing:.22em;white-space:nowrap}.gold-foot:before,.gold-foot:after{content:"";height:1px;flex:1;background:linear-gradient(90deg,transparent,#8a6329)}.gold-foot:after{background:linear-gradient(90deg,#8a6329,transparent)}
@media(max-width:370px){.gold-shell{padding-left:10px;padding-right:10px}.gold-hero{height:415px;margin-left:-10px;margin-right:-10px}.stk{width:205px;height:205px}.stk:before{font-size:121px}.stk:after{font-size:51px}.gold-stack{font-size:44px}.gold-hold{font-size:35px}.gold-grinder{font-size:52px}.gold-copy strong{font-size:15px}.gold-auth,.gold-two{grid-template-columns:1fr}}
`}</style><div className="gold-shell">
    <section className="gold-hero">
      <div className="aces"><div className="ace"><span>A</span><span>♠</span></div><div className="ace"><span>A</span><span>♥</span></div><div className="ace"><span>A</span><span>♣</span></div><div className="ace"><span>A</span><span>♦</span></div></div>
      <div className="chips left"/><div className="chips right"/><div className="stk"/>
      <div className="gold-brand"><b className="gold-stack">STACKUP</b><b className="gold-hold">HOLD'EM</b><b className="gold-grinder">GRINDER</b><small>DECIDA COM CONSISTÊNCIA</small></div>
    </section>
    <Card id="lang" icon="globe" title="IDIOMA" sub="Selecione seu idioma"/>
    <Drawer id="lang"><div className="gold-grid gold-two"><button className={"gold-choice "+(draftLanguage==="pt"?"selected":"")} onClick={()=>setDraftLanguage("pt")}>PORTUGUÊS (BR)</button><button className={"gold-choice "+(draftLanguage==="en"?"selected":"")} onClick={()=>setDraftLanguage("en")}>ENGLISH (US)</button></div><div className="gold-actions"><button className="gold-action" onClick={()=>{setDraftLanguage(language);setDrawer(null)}}>CANCELAR</button><button className="gold-action primary" onClick={()=>{setLanguage(draftLanguage);setDrawer(null)}}>CONFIRMAR</button></div></Drawer>
    <Card id="quick" icon="finger" title="ACESSO RÁPIDO" sub="Entre de forma rápida e segura"/>
    <Drawer id="quick"><div className="gold-auth"><button className="gold-choice"><Icon type="finger"/><span>BIOMETRIA<small>Usar biometria do dispositivo</small></span></button><button className="gold-choice"><span className="gold-google">G</span><span>ENTRAR COM GOOGLE<small>Sua conta Google</small></span></button></div></Drawer>
    <Card id="login" icon="wa" title="LOGIN COM WHATSAPP" sub={<>Receba um código de 4 dígitos<br/>no seu WhatsApp</>}/>
    <Drawer id="login"><div className="gold-phone"><div className="gold-country">+55</div><input className="gold-field" inputMode="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="(11) 98765-4321"/></div>{!otpSent?<button className="gold-action primary gold-send" onClick={()=>setOtpSent(true)}>ENVIAR CÓDIGO</button>:<><div className="gold-otps">{otp.map((v,i)=><input key={i} className="gold-otp" inputMode="numeric" maxLength={1} value={v} onChange={e=>{const n=[...otp];n[i]=e.target.value.replace(/\D/g,"").slice(-1);setOtp(n)}}/>)}</div><label className="gold-keep"><input type="checkbox" checked={keepLogged} onChange={e=>setKeepLogged(e.target.checked)}/>PERMANECER LOGADO</label><div className="gold-actions"><button className="gold-action" onClick={()=>{setOtpSent(false);setOtp(["","","",""]);setDrawer(null)}}>CANCELAR</button><button className="gold-action primary" onClick={()=>onEnter?.()}>CONFIRMAR</button></div></>}</Drawer>
    <footer className="gold-foot">TREINE · EVOLUA · DECIDA MELHOR</footer>
  </div></div>;
}

export default function App() {
  const [openingScreen, setOpeningScreen] = useState(true);
  const [modalidade, setModalidade] = useState("regular");
  const [field, setField] = useState(100);
  const [mix, setMix] = useState("50");
  const [tableSize, setTableSize] = useState(9);
  const [fase, setFase] = useState("ALEATORIO");
  const [street, setStreet] = useState("MIXED");
  const [heroPositionFilter, setHeroPositionFilter] = useState("ALEATORIO");
  const [stackFilter, setStackFilter] = useState("ALEATORIO");
  const [spotsPerFase, setSpotsPerFase] = useState(500);
  const [spotIndex, setSpotIndex] = useState(1);
  const [faseProgress, setFaseProgress] = useState({});
  const [decision, setDecision] = useState(null);
  const [reviewUnlockedSpotKey, setReviewUnlockedSpotKey] = useState(null);
  const [actionFlowEnabled, setActionFlowEnabled] = useState(false);
  const [actionStep, setActionStep] = useState(-1);
  const [sequenceReady, setSequenceReady] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [actionPaused, setActionPaused] = useState(false);
  const [shotClockRemaining, setShotClockRemaining] = useState(20);
  const actionSpeed = 1;
  const [rigorMode, setRigorMode] = useState(false);
  const [examMode, setExamMode] = useState(false);
  const [examLength, setExamLength] = useState(25);
  const [examStartIndex, setExamStartIndex] = useState(0);
  const [examReport, setExamReport] = useState(null);
  const [decisionElapsedMs, setDecisionElapsedMs] = useState(0);
  const boardSectionRef = useRef(null);
  const gameFocusRequestedRef = useRef(false);

  // ---------- MODO TORNEIO (Fase 4 — tela) ----------
  // O estado de verdade do torneio (níveis, campo, mesa, stacks) vive numa ref — as funções do
  // motor (tournamentEngine/tournamentTableEngine) mutam esses objetos diretamente em vez de
  // devolver cópia nova a cada mão (mesmo padrão usado nos testes automatizados). torneioInfo é
  // só um resumo leve, em useState, atualizado depois de cada mudança — é ele que dispara o
  // re-render da tela; a ref nunca é lida diretamente no JSX.
  const [torneioMode, setTorneioMode] = useState(false);
  const torneioEngineRef = useRef({ tournamentState: null, tableState: null });
  const [torneioInfo, setTorneioInfo] = useState(null); // null = nenhum torneio rodando ainda
  const [torneioReport, setTorneioReport] = useState(null); // preenchido só quando o torneio termina
  // Mão de torneio em andamento: null enquanto não há decisão pendente do herói (mãos sem
  // envolvimento dele avançam sozinhas, "avança rápido", como já era o combinado). Quando existe
  // uma decisão de verdade pra mostrar, torneioContext/torneioHeroCards ficam preenchidos e os
  // botões de ação da tela chamam handleTorneioAction em vez do fluxo normal de treino.
  const [torneioContext, setTorneioContext] = useState(null);
  // "Retrato" de todos os assentos da mesa no instante da decisão (posição, quanto cada um tem
  // de stack e já apostou nesta rodada, quem foldou) — alimenta a mesma mesa visual do treino
  // normal (ver clockwiseSeats/clockwiseGrid mais abaixo), só que com dados reais do torneio.
  const [torneioSeats, setTorneioSeats] = useState(null);
  const [torneioHeroCards, setTorneioHeroCards] = useState(null);
  const torneioPendingRef = useRef(null);

  // ---------- Configuração do torneio (escolhida antes de ativar) ----------
  const [torneioCfgFieldSize, setTorneioCfgFieldSize] = useState(100);
  const [torneioCfgTipo, setTorneioCfgTipo] = useState("NORMAL");
  const [torneioCfgFormato, setTorneioCfgFormato] = useState("REBUY");
  const [torneioCfgTakesAddOn, setTorneioCfgTakesAddOn] = useState(true);
  const [torneioCfgStack, setTorneioCfgStack] = useState(40000);
  const [torneioCfgHandsPerLevel, setTorneioCfgHandsPerLevel] = useState(40);

  // ---------- Ranking histórico entre torneios (persistente, localStorage) ----------
  const TORNEIO_RANKING_KEY = "nlh-torneio-ranking-histogram-v1";
  const [torneioRankingHistogram, setTorneioRankingHistogram] = useState(() => {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(TORNEIO_RANKING_KEY) : null;
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  function recordTorneioFinishToRanking(finishRank) {
    if (!finishRank) return;
    setTorneioRankingHistogram((prev) => {
      const updated = recordFinish(prev, finishRank);
      try { if (window.localStorage) window.localStorage.setItem(TORNEIO_RANKING_KEY, JSON.stringify(updated)); } catch { /* ignora falha de storage */ }
      return updated;
    });
  }

  function refreshTorneioInfo() {
    const { tournamentState } = torneioEngineRef.current;
    if (!tournamentState) { setTorneioInfo(null); setTorneioReport(null); return; }
    const mesas = Math.max(1, Math.ceil(tournamentState.fieldRemaining / 9));
    const stackMedio = Math.round(tournamentState.totalChipsInPlay / tournamentState.fieldRemaining);
    setTorneioInfo({
      jogadores: tournamentState.fieldRemaining,
      mesas,
      tipo: tournamentState.config.tournamentType,
      formato: tournamentState.config.buyInMode,
      stackTotal: tournamentState.heroStack,
      stackMedio,
      nivel: tournamentState.level,
      fase: tCurrentFase(tournamentState),
      bb: tCurrentBlinds(tournamentState).bb,
      finished: tournamentState.finished,
      finishRank: tournamentState.finishRank,
    });
    // O relatório final é um card À PARTE (dentro da área do torneio, nunca misturado com o
    // card de histórico/revisão que já existe no resto do app) — só existe depois que o
    // torneio termina de verdade.
    setTorneioReport(tournamentState.finished ? buildTournamentReport(tournamentState) : null);
    // Registra a colocação no ranking histórico (persistente) exatamente uma vez por torneio —
    // refreshTorneioInfo pode ser chamada várias vezes depois do fim (ex: se o usuário mexer em
    // outra coisa), então marca no próprio engineRef que já registrou.
    if (tournamentState.finished && !torneioEngineRef.current.rankingRecorded) {
      torneioEngineRef.current.rankingRecorded = true;
      recordTorneioFinishToRanking(tournamentState.finishRank);
    }
  }

  // Aplica o resultado de UMA mão já resolvida (status "done") no motor de torneio (Fase 1) e
  // atualiza a tela — usado tanto pra mãos que o herói decidiu quanto pras que "avançaram
  // rápido" sozinhas (nunca pediram decisão dele).
  function applyTorneioHandDone(step) {
    const { tournamentState } = torneioEngineRef.current;
    tAdvanceHand(tournamentState, { heroChipDelta: step.heroChipDelta, heroBusted: tournamentState.heroStack + step.heroChipDelta <= 0 }, torneioEngineRef.current.rng);
    refreshTorneioInfo();
  }

  // Começa a próxima mão da mesa do herói. Mãos onde ele não é envolvido (ex: ganha de graça no
  // BB porque todo mundo foldou antes) resolvem sozinhas em sequência ("avança rápido", como já
  // era o combinado) até chegar numa decisão de verdade pra mostrar — ou até o torneio acabar.
  // Consulta o banco geral de spots do app (o MESMO banco que TREINO POR FASE/POSIÇÃO/STREET já
  // usam) por fase+posição, e — se existir alguma mão coincidente ali — "encomenda" as cartas
  // concretas do herói a partir de lá, em vez de deixá-las puramente aleatórias. Não muda como a
  // mesa inteira joga (adversários pela IA, pote, showdown continuam pelo motor de torneio já
  // testado) — só a origem da mão do herói no instante da decisão. Sem entrada coincidente,
  // devolve null e a mão segue com cartas aleatórias normais (nada quebra).
  function pickHeroCardsFromBank(faseKey, heroPosition, rng) {
    const entries = selectGeneralSpots(faseKey, "PRE-FLOP").filter((e) => e.position === heroPosition);
    if (!entries.length) return null;
    const entry = entries[Math.floor(rng() * entries.length)];
    const archetype = HAND_TYPE_MAP[entry.handType];
    if (!archetype) return null;
    const suits = shuffle(SUITS, rng);
    if (archetype.pair) return [{ v: archetype.a, s: suits[0] }, { v: archetype.a, s: suits[1] }];
    if (archetype.suited) return [{ v: archetype.a, s: suits[0] }, { v: archetype.b, s: suits[0] }];
    return [{ v: archetype.a, s: suits[0] }, { v: archetype.b, s: suits[1] }];
  }

  // Monta o "retrato" da mesa neste instante a partir do cursor do motor (Fase 2, pausável) —
  // usado só pra alimentar a mesa visual (ver clockwiseSeats mais abaixo); nunca revela as
  // cartas dos adversários, só posição/stack/aposta/fold, exatamente o que já era visível numa
  // mesa de pôquer de verdade.
  function snapshotTorneioSeats(cursor) {
    return cursor.positions.map((pos, idx) => ({
      pos,
      isHero: idx === cursor.heroIndex,
      folded: cursor.folded[idx],
      committedBB: cursor.committedBB[idx],
      stackBB: cursor.effectiveStacksBB[idx],
    }));
  }

  function beginNextTorneioHand() {
    const engine = torneioEngineRef.current;
    if (!engine.tournamentState || engine.tournamentState.finished) { setTorneioContext(null); setTorneioHeroCards(null); setTorneioSeats(null); return; }
    let guard = 0;
    const attemptOnce = () => {
      const handSeed = `ui-${engine.tournamentState.handsPlayed}-${engine.rng()}`;
      const faseKey = tCurrentFase(engine.tournamentState);
      const heroPosition = peekHeroPositionForNextHand({ tableState: engine.tableState, tournamentState: engine.tournamentState, handSeed });
      const heroCardsOverride = pickHeroCardsFromBank(faseKey, heroPosition, engine.rng);
      return beginTableHand({ tableState: engine.tableState, tournamentState: engine.tournamentState, handSeed, heroCardsOverride });
    };
    let step = attemptOnce();
    while (step.status === "done" && guard++ < 50) {
      applyTorneioHandDone(step);
      if (engine.tournamentState.finished) { setTorneioContext(null); setTorneioHeroCards(null); setTorneioSeats(null); return; }
      step = attemptOnce();
    }
    if (step.status === "awaiting_hero") {
      torneioPendingRef.current = step.pending;
      setTorneioContext(step.context);
      setTorneioHeroCards(step.heroCards);
      setTorneioSeats(snapshotTorneioSeats(step.pending.session.cursor));
    }
  }

  // Chamada pelos botões de decisão do Modo Torneio (FOLD/CALL/RAISE/SHOVE) — nunca passa pelo
  // handleAction normal do treino (grading, histórico de revisão etc. não se aplicam aqui).
  function handleTorneioAction(action, raiseToBB) {
    if (!torneioPendingRef.current) return;
    const step = resumeTableHand(torneioPendingRef.current, { action, raiseToBB });
    if (step.status === "awaiting_hero") {
      torneioPendingRef.current = step.pending;
      setTorneioContext(step.context);
      setTorneioHeroCards(step.heroCards); // mesma mão continua — cartas não mudam, só o contexto
      setTorneioSeats(snapshotTorneioSeats(step.pending.session.cursor));
      return;
    }
    applyTorneioHandDone(step);
    beginNextTorneioHand();
  }

  // Config padrão pra iniciar o torneio — a tela de configuração (campo/tipo/formato/stack
  // inicial/mãos por nível) é a próxima parte; por enquanto usa um padrão razoável pra já
  // validar o card e o time bank na tela de verdade.
  function startTorneio() {
    let seed = generateTorneioSeed();
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const config = createTournamentConfig({
      fieldSize: torneioCfgFieldSize, tournamentType: torneioCfgTipo, buyInMode: torneioCfgFormato,
      startingStack: torneioCfgStack, handsPerLevelConfig: torneioCfgHandsPerLevel,
      takesAddOn: torneioCfgFormato === "REBUY" ? torneioCfgTakesAddOn : true,
    });
    const tournamentState = initTournament(config, rng);
    const avgStack0 = tournamentState.totalChipsInPlay / tournamentState.fieldRemaining;
    const tableState = tInitTable(tournamentState, avgStack0, rng);
    torneioEngineRef.current = { tournamentState, tableState, rng, rankingRecorded: false };
    setTorneioMode(true);
    setTorneioReport(null);
    refreshTorneioInfo();
    beginNextTorneioHand();
  }

  function stopTorneio() {
    torneioEngineRef.current = { tournamentState: null, tableState: null, rng: null };
    torneioPendingRef.current = null;
    setTorneioMode(false);
    setTorneioInfo(null);
    setTorneioReport(null);
    setTorneioContext(null);
    setTorneioHeroCards(null);
    setTorneioSeats(null);
  }

  const playersSectionRef = useRef(null);
  const potSectionRef = useRef(null);
  const reportPanelRef = useRef(null);
  const audioContextRef = useRef(null);
  const reverbNodeRef = useRef(null);
  const lastSoundedStepRef = useRef(-1);
  const decisionStartedAtRef = useRef(null);
  // O primeiro HTML precisa ser idêntico no servidor e no navegador. A aleatoriedade da
  // sessão entra somente depois da hidratação; antes, os cliques podiam ser descartados
  // quando o React reconstruía toda a árvore por divergência de conteúdo.
  const [sessionStart, setSessionStart] = useState(0);
  const [sessionStepRaw, setSessionStepRaw] = useState(1);
  const [sessionSeed, setSessionSeed] = useState("STACKUP-INITIAL");

  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [openConfigPanel, setOpenConfigPanel] = useState(null);
  const [showConfigCards, setShowConfigCards] = useState(false);
  const [showSimuladorCards, setShowSimuladorCards] = useState(false);
  const [aiProvider, setAiProvider] = useState(null); // null = INATIVO (padrão, até o usuário escolher um provedor)
  const [aiKeys, setAiKeys] = useState({ openai: "", anthropic: "", google: "" });
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [aiPhoto, setAiPhoto] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [aiReportLoading, setAiReportLoading] = useState(false);
  const [aiReportError, setAiReportError] = useState(null);
  const [aiReport, setAiReport] = useState(null);
  // GERAÇÃO DE SPOTS POR IA (BETA): desligada por padrão, exige provedor+chave já configurados
  // acima. aiSpotCache guarda entradas já buscadas por chave de spot (ver aiSpotCacheKey), pra
  // nunca refazer a chamada de rede pro mesmo spot (inclusive ao navegar ANTERIOR/PRÓXIMO de
  // volta pra ele). Só ativa quando FASE e STREET são escolhas explícitas (não ALEATÓRIO/MIXED)
  // — sem isso o app não saberia de antemão qual fase/street pedir pra IA, já que MIXED/ALEATÓRIO
  // só resolvem isso sorteando por dentro da própria geração do spot.
  const [aiSpotGenerationEnabled, setAiSpotGenerationEnabled] = useState(false);
  const [aiSpotCache, setAiSpotCache] = useState({});
  const [aiSpotFetching, setAiSpotFetching] = useState(false);
  const aiSpotFetchKeyRef = useRef(null);

  const [activePresetKey, setActivePresetKey] = useState(null);
  const [presetProgress, setPresetProgress] = useState({});
  const [sessionCompleteNotice, setSessionCompleteNotice] = useState(false);
  const [leakMode, setLeakMode] = useState(false);
  const activePreset = TRAINING_PRESETS.find((p) => p.key === activePresetKey) || null;
  // Alternância "clicar pra ativar, clicar pra desativar" — mesmo padrão já usado no TREINO
  // ESPECÍFICO (selectPreset): clicar na opção já ativa volta pro valor neutro; clicar numa
  // opção diferente enquanto algo não-neutro já está ativo não faz nada — precisa desativar
  // primeiro. Clicar direto no próprio neutro sempre funciona. Usado pelas configurações que
  // sempre precisam de ALGUM valor concreto pra funcionar (tipo de torneio, tamanho de campo,
  // amostragem, config do torneio etc.) — nunca ficam "sem nada selecionado".
  const handleToggleClick = (currentValue, neutralValue, clickedValue, applyFn) => {
    if (clickedValue === neutralValue) { applyFn(neutralValue); return; }
    if (currentValue === clickedValue) { applyFn(neutralValue); return; }
    if (currentValue !== neutralValue) return;
    applyFn(clickedValue);
  };
  // Mesmo padrão, mas pros 4 filtros de treino cumulativo (FASE/STREET/POSIÇÃO/STACK) que têm
  // um botão ALEATÓRIO de verdade: desativar deixa SEM NADA selecionado (null) — nem o próprio
  // ALEATÓRIO fica destacado — em vez de voltar automaticamente pro ALEATÓRIO. Tanto null
  // quanto o neutro são pontos de partida "livres": dá pra ir direto deles pra qualquer opção.
  // Funcionalmente, null e ALEATÓRIO continuam equivalentes (nenhum filtro aplicado) — só muda
  // o destaque visual.
  const handleFilterToggleClick = (currentValue, neutralValue, clickedValue, applyFn) => {
    if (currentValue === clickedValue) { applyFn(null); return; }
    if (currentValue !== null && currentValue !== neutralValue) return;
    applyFn(clickedValue);
  };

  const selectPreset = (preset) => {
    if (activePresetKey === preset.key) { setActivePresetKey(null); setSessionCompleteNotice(false); resetHuSession(); return; }
    // Não troca direto de um spot ativo pra outro — precisa desativar o atual primeiro (clicar
    // nele de novo, o que cai no "if" acima) antes de conseguir escolher um novo. Sempre pode
    // ir de INATIVO (activePresetKey === null) pra qualquer spot direto.
    if (activePresetKey !== null && preset.key !== null) return;
    setActivePresetKey(preset.key);
    if (preset.faseOverride) setFase(preset.faseOverride);
    // Defesa/ataque de BB só existem no pré-flop — força a street. CO/BTN, CHIP UP e REAÇÃO A
    // 3-BET funcionam em qualquer street, inclusive MIXED, então não mexem na seleção atual.
    if (preset.forceStreetPreflop) setStreet("PRE-FLOP");
    if (preset.forcePostflop && street === "PRE-FLOP") setStreet("FLOP");
    if (preset.streetOnly) setStreet(preset.streetOnly);
    if (preset.requiresTableSize === 2 || preset.tableStructure === "HU_2MAX") setTableSize(2);
    if (preset.requiresBounty) setModalidade("bounty");
    setSpotIndex(1);
    setDecision(null);
    setSessionCompleteNotice(false);
    resetHuSession();
  };

  const handlePresetLockedClick = (preset) => {
    selectPreset(preset);
  };

  const [history, setHistory] = useState([]);
  // null enquanto a preferência salva ainda não carregou (evita decidir "apagar" por engano
  // antes de saber o que o usuário escolheu da última vez) — true = MANTER DADOS (padrão).
  const [keepDataOnRestart, setKeepDataOnRestart] = useState(null);
  // Marca de onde a sessão de contagem do HU/TOTAL começa (índice em `history`). Reiniciada a
  // cada escolha de treino (fase, street, treino específico) — ver resetHuSession abaixo.
  const [huSessionStart, setHuSessionStart] = useState(0);
  const resetHuSession = () => setHuSessionStart(history.length);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [reviewQueue, setReviewQueue] = useState([]);
  const [sessionOpenedAt, setSessionOpenedAt] = useState(0);
  const [userEmail, setUserEmail] = useState("");
  const [userWhatsapp, setUserWhatsapp] = useState("");

  useEffect(() => {
    setSessionStart(Math.floor(Math.random() * 1000000));
    setSessionStepRaw(Math.floor(Math.random() * 1000000) + 1);
    setSessionSeed(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setSessionOpenedAt(Date.now());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A preferência de apagar/manter precisa carregar ANTES do histórico, senão corre o risco
      // de carregar dados que deveriam ter sido apagados neste boot.
      let keepData = true;
      try {
        const keepResult = await appStorage.get("keep-training-data");
        if (keepResult && keepResult.value != null) keepData = keepResult.value !== "false";
      } catch { /* ainda não configurado — mantém o padrão (MANTER DADOS) */ }
      if (!cancelled) setKeepDataOnRestart(keepData);

      if (!keepData) {
        // APAGAR DADOS: começa este boot zerado e já limpa o que estava salvo, pra não voltar
        // na próxima vez que o usuário mudar de ideia sem querer.
        try { await appStorage.set("training-history", JSON.stringify([])); } catch { /* melhor esforço */ }
      } else {
        try {
          const r = await appStorage.get("training-history");
          if (!cancelled && r && r.value) {
            const parsed = JSON.parse(r.value);
            if (Array.isArray(parsed)) {
              setHistory(parsed);
              // Histórico persistido é retrospectivo; não pode entrar como se tivesse sido
              // treinado na sessão que acabou de abrir.
              setHuSessionStart(parsed.length);
            }
          }
        } catch { /* ainda não existe histórico salvo */ }
      }
      try {
        const reviewResult = await appStorage.get("spaced-review-queue");
        if (!cancelled && reviewResult && reviewResult.value) {
          const parsedReviews = JSON.parse(reviewResult.value);
          if (Array.isArray(parsedReviews)) setReviewQueue(parsedReviews);
        }
      } catch { /* ainda não existem revisões agendadas */ }
      try {
        const r2 = await appStorage.get("user-contacts");
        if (!cancelled && r2 && r2.value) {
          const c = JSON.parse(r2.value);
          setUserEmail(c.email || "");
          setUserWhatsapp(c.whatsapp || "");
        }
      } catch { /* ainda não cadastrado */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const chooseKeepDataOnRestart = async (value) => {
    setKeepDataOnRestart(value);
    try { await appStorage.set("keep-training-data", value ? "true" : "false"); } catch { /* melhor esforço */ }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDecision(null), 0);
    return () => window.clearTimeout(timer);
  }, [modalidade, field, mix, tableSize, fase, street, activePresetKey]);

  const updateContactField = (email, whatsapp) => { setUserEmail(email); setUserWhatsapp(whatsapp); };
  const persistContacts = async () => {
    try { await appStorage.set("user-contacts", JSON.stringify({ email: userEmail, whatsapp: userWhatsapp })); } catch { /* melhor esforço */ }
  };

  const toggleReportPanel = () => {
    setHistoryPanelOpen((open) => {
      const next = !open;
      if (next) window.setTimeout(() => reportPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = { openai: "", anthropic: "", google: "" };
      for (const p of AI_PROVIDERS) {
        try {
          const r = await appStorage.get(`ai-key-${p.key}`);
          if (r && r.value) loaded[p.key] = r.value;
        } catch { /* chave ainda não salva — ok */ }
      }
      if (!cancelled) setAiKeys(loaded);
    })();
    return () => { cancelled = true; };
  }, []);

  const saveAiKey = async (provider, key) => {
    setAiKeys((k) => ({ ...k, [provider]: key }));
    try { await appStorage.set(`ai-key-${provider}`, key); } catch { /* melhor esforço */ }
  };

  const handlePhotoSelect = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setAiError("Selecione um arquivo de imagem válido."); return; }
    if (file.size > 10 * 1024 * 1024) { setAiError("A imagem deve ter no máximo 10 MB."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1];
      if (!base64) { setAiError("Não foi possível ler a imagem selecionada."); return; }
      setAiPhoto({ base64, mediaType: file.type || "image/jpeg" });
      setAiResult(null);
      setAiError(null);
    };
    reader.onerror = () => setAiError("Não foi possível ler a imagem selecionada.");
    reader.readAsDataURL(file);
  };

  const runAiAnalysis = async () => {
    const key = aiKeys[aiProvider];
    if (!key) { setAiError("Cole sua chave de API antes de analisar."); return; }
    if (!aiPhoto) { setAiError("Selecione uma foto da estrutura primeiro."); return; }
    setAiLoading(true); setAiError(null); setAiResult(null);
    try {
      const json = await AI_CALLERS[aiProvider](key, STRUCTURE_PROMPT, aiPhoto, "json");
      if (json.__parseError) {
        setAiError(`A IA respondeu, mas o formato não pôde ser interpretado (${json.__reason}). Tente novamente com outra foto ou mais nítida.`);
        return;
      }
      const validField = FIELDS.includes(json.field) ? json.field : field;
      const validTable = TABLES.includes(json.tableSize) ? json.tableSize : tableSize;
      const validModalidade = MODALIDADES.some((m) => m.key === json.modalidade) ? json.modalidade : modalidade;
      setModalidade(validModalidade);
      setField(validField);
      setTableSize(validTable);
      setAiResult(json.observacoes || "Configuração aplicada.");
    } catch (e) {
      setAiError(`Falha ao consultar ${aiProvider.toUpperCase()}: ${e.message}. Se o provedor bloquear chamada direta do navegador (CORS), essa chamada só vai funcionar de fato quando o app estiver empacotado como .apk nativo.`);
    } finally {
      setAiLoading(false);
    }
  };

  const runAiReport = async () => {
    const key = aiKeys[aiProvider];
    if (!key) { setAiReportError("Configure sua chave de API na seção INTEGRAR IA primeiro."); return; }
    if (history.length === 0) { setAiReportError("Ainda não há spots treinados para gerar relatório."); return; }
    setAiReportLoading(true); setAiReportError(null); setAiReport(null);
    try {
      const prompt = REPORT_PROMPT_PREFIX + buildHistorySummary();
      const text = await AI_CALLERS[aiProvider](key, prompt, null, "text");
      setAiReport(text);
    } catch (e) {
      setAiReportError(`Falha ao gerar relatório com ${aiProvider.toUpperCase()}: ${e.message}. Se o provedor bloquear chamada direta do navegador (CORS), isso só vai funcionar de fato no app empacotado como .apk nativo.`);
    } finally {
      setAiReportLoading(false);
    }
  };

  const dueReview = examMode ? null : reviewQueue.find((review) => Number(review.dueCount || Infinity) <= history.length || (review.dueAt && review.dueAt <= sessionOpenedAt)) || null;
  // A revisão elegível é capturada somente quando uma mão é aberta. Alterações no histórico
  // causadas pela resposta atual não podem trocar o spot por baixo do jogador; a próxima
  // revisão só entra quando PRÓXIMO altera spotIndex (ou quando o treino é reconfigurado).
  const cfg = useMemo(() => {
    if (dueReview) {
      const reviewPreset = TRAINING_PRESETS.find((preset) => preset.key === dueReview.cfg.presetKey) || null;
      return { ...dueReview.cfg, preset: reviewPreset, reviewId: dueReview.id, sessionStart, sessionStepRaw, sessionSeed, trainingTarget: spotsPerFase };
    }
    return { modalidade, field, mix, tableSize, fase, street, heroPositionFilter, stackFilterBB: (!activePreset && stackFilter !== "ALEATORIO") ? stackFilter : null, spotIndex, reviewId: null, sessionStart, sessionStepRaw, sessionSeed, trainingTarget: spotsPerFase, preset: activePreset };
    // `dueReview` é intencionalmente excluída: ela pode mudar ao salvar a resposta da mão atual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalidade, field, mix, tableSize, fase, street, heroPositionFilter, stackFilter, spotIndex, sessionStart, sessionStepRaw, sessionSeed, spotsPerFase, activePreset]);
  // GERAÇÃO DE SPOTS POR IA (BETA) — só elegível com FASE e STREET explícitos (não
  // ALEATÓRIO/MIXED, ver comentário do state acima) e fora de revisão (dueReview tem seu próprio
  // spot fixo, não faz sentido a IA escolher outro). aiSpotCacheKey não usa spot.street (ainda não
  // existe nesse ponto) — usa cfg.street diretamente, que já é a mesma coisa quando elegível.
  const aiSpotEligible = aiSpotGenerationEnabled && !!aiProvider && !!aiKeys[aiProvider] && !cfg.reviewId
    && cfg.fase && cfg.fase !== "ALEATORIO" && cfg.street && cfg.street !== "MIXED";
  const aiSpotCacheKey = aiSpotEligible
    ? `${sessionSeed}|${cfg.fase}|${cfg.street}|${cfg.spotIndex}|${cfg.preset?.key || "GERAL"}`
    : null;
  const aiForcedEntry = aiSpotCacheKey ? aiSpotCache[aiSpotCacheKey] || null : null;
  const spot = useMemo(() => generateSpot(aiForcedEntry ? { ...cfg, forcedEntry: aiForcedEntry } : cfg), [cfg, aiForcedEntry]);
  const analysis = useMemo(() => computeAnalysis(spot, cfg), [spot, cfg]);
  const activeDueReview = cfg.reviewId ? reviewQueue.find((review) => review.id === cfg.reviewId) || null : null;
  const currentSpotKey = `${sessionSeed}|${cfg.fase}|${spot.street}|${cfg.spotIndex}|${cfg.preset?.key || "GERAL"}|${cfg.reviewId || "NOVO"}`;
  const currentSpotWasAnswered = history.some((entry) => entry.spotKey === currentSpotKey);
  const currentSpotIsLocked = !!decision || (currentSpotWasAnswered && reviewUnlockedSpotKey !== currentSpotKey);
  // Pré-busca da GERAÇÃO DE SPOTS POR IA — nunca bloqueia a mesa: enquanto a IA não responde (ou
  // se falhar/der timeout), `spot` acima já está usando o gerador local normalmente (aiForcedEntry
  // só existe depois que o cache é preenchido aqui). `history`/`cfg` entram nas deps só pra manter
  // o resumo/parâmetros atualizados — diferente do bug corrigido no efeito de replay de ações
  // (ver useEffect de actionStep mais abaixo), aqui cada re-execução é barata e idempotente: as
  // duas guardas (cache já preenchido / já buscando esta mesma chave) impedem qualquer chamada de
  // rede duplicada, então incluir esses deps não recria o problema de antes.
  useEffect(() => {
    if (!aiSpotCacheKey || aiSpotCache[aiSpotCacheKey] || aiSpotFetchKeyRef.current === aiSpotCacheKey) return;
    aiSpotFetchKeyRef.current = aiSpotCacheKey;
    setAiSpotFetching(true);
    let cancelled = false;
    const recentSummary = history.slice(-5).map((entry) => `${entry.position || "?"}/${entry.scenario || entry.street || "?"}`).join(", ");
    fetchAiForcedEntry({ provider: aiProvider, apiKey: aiKeys[aiProvider], cfg, faseKey: cfg.fase, streetKey: cfg.street, recentSummary })
      .then((entry) => { if (!cancelled && entry) setAiSpotCache((prev) => ({ ...prev, [aiSpotCacheKey]: entry })); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAiSpotFetching(false); aiSpotFetchKeyRef.current = null; });
    return () => { cancelled = true; };
  }, [aiSpotCacheKey, aiSpotCache, aiProvider, aiKeys, cfg, history]);
  const examProgress = Math.min(examLength, Math.max(0, history.length - examStartIndex));

  const startExam = () => {
    setExamMode(true);
    setRigorMode(true);
    setExamStartIndex(history.length);
    setExamReport(null);
    setDecision(null);
    setSessionCompleteNotice(false);
    setSpotIndex(1);
  };

  const finishExam = (entriesOverride = null) => {
    const entries = entriesOverride || history.slice(examStartIndex);
    if (entries.length === 0) return;
    const grouped = entries.reduce((acc, entry) => {
      const key = entry.presetKey || entry.scenario || entry.street || "GERAL";
      if (!acc[key]) acc[key] = { key, count: 0, correct: 0, loss: 0 };
      acc[key].count += 1;
      acc[key].correct += entry.correct ? 1 : 0;
      acc[key].loss += Number(entry.evLossBB || 0);
      return acc;
    }, {});
    const groups = Object.values(grouped).map((group) => ({ ...group, accuracy: group.correct / group.count, avgLoss: group.loss / group.count }));
    const leak = [...groups].sort((a, b) => b.avgLoss - a.avgLoss || a.accuracy - b.accuracy)[0];
    const strength = [...groups].sort((a, b) => b.accuracy - a.accuracy || a.avgLoss - b.avgLoss)[0];
    const preset = TRAINING_PRESETS.find((item) => item.key === leak?.key);
    setExamReport({
      count: entries.length,
      accuracy: entries.filter((entry) => entry.correct).length / entries.length * 100,
      totalLoss: entries.reduce((sum, entry) => sum + Number(entry.evLossBB || 0), 0),
      avgTime: entries.reduce((sum, entry) => sum + Number(entry.responseMs || 0), 0) / entries.length / 1000,
      leak: leak?.key || "GERAL",
      strength: strength?.key || "GERAL",
      recommendation: preset?.label || (leak?.key ? `TREINAR ${String(leak.key).replaceAll("_", " ")}` : "TREINO RANDOM"),
    });
  };

  const toggleExam = () => {
    if (examMode) {
      setExamMode(false);
      setRigorMode(false);
      setExamStartIndex(history.length);
      setExamReport(null);
      setDecision(null);
      return;
    }
    startExam();
  };

  const advance = (dir) => {
    const next = Math.max(1, spotIndex + dir);
    let newFase = fase;
    let newSpotIndex = next;
    if (dir > 0) {
      // Avançar sem responder serve apenas para navegar; nunca conta progresso nem conclui fase.
      if (!decision) {
        gameFocusRequestedRef.current = true;
        setSpotIndex(newSpotIndex);
        return;
      }
      // Progresso = maior spot já alcançado, não contagem de cliques — ir "ANTERIOR" e
      // depois "PRÓXIMO" de novo não infla o progresso. Treino específico ativo tem seu
      // próprio contador, separado do progresso normal da fase.
      if (activePreset) {
        const prevProgress = presetProgress[activePreset.key] || 0;
        const newPresetProgress = Math.min(spotsPerFase, Math.max(prevProgress, spotIndex));
        setPresetProgress((p) => ({ ...p, [activePreset.key]: newPresetProgress }));
        if (newPresetProgress >= spotsPerFase && prevProgress < spotsPerFase) setSessionCompleteNotice(true);
      } else {
        const prevProgress = faseProgress[fase] || 0;
        const newProgress = Math.min(spotsPerFase, Math.max(prevProgress, spotIndex));
        setFaseProgress((p) => ({ ...p, [fase]: newProgress }));
        if (newProgress >= spotsPerFase && prevProgress < spotsPerFase) setSessionCompleteNotice(true);
        // Evolução sempre automática: ao bater a meta da fase, avança pra próxima na ordem
        // horizontal (PROGRESSION_ORDER), sem depender de nenhum seletor de modo.
        if (newProgress >= spotsPerFase) {
          const idx = PROGRESSION_ORDER.indexOf(fase);
          if (idx >= 0 && idx < PROGRESSION_ORDER.length - 1) { newFase = PROGRESSION_ORDER[idx + 1]; newSpotIndex = 1; }
        }
      }
    }
    setFase(newFase);
    setSpotIndex(newSpotIndex);
    setDecision(null);
    setReviewUnlockedSpotKey(null);
    // ANTERIOR e PRÓXIMO reposicionam a tela do mesmo jeito que INICIAR — POT preso na borda
    // superior (antes só PRÓXIMO fazia isso, e mirava no board, não no pote).
    gameFocusRequestedRef.current = true;
  };

  // ANTERIOR/PRÓXIMO só reposicionam depois que a nova mão foi realmente renderizada. Uma
  // segunda ancoragem absorve mudanças de altura causadas pelo board, pote e início das
  // animações.
  useEffect(() => {
    if (!gameFocusRequestedRef.current) return;
    const alignGameArea = () => potSectionRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
    const frame = window.requestAnimationFrame(alignGameArea);
    const stabilizationTimer = window.setTimeout(() => {
      alignGameArea();
      // Só limpa a referência aqui se não tiver uma sequência de revelação em andamento
      // (actionFlowEnabled) — nesse caso, quem realmente sabe quando a tela se estabilizou de
      // vez é o efeito que acompanha o fim da sequência (mais abaixo), não este timer fixo de
      // 360ms, que pode terminar antes de uma sequência longa (vários adversários agindo).
      if (!actionFlowEnabled) gameFocusRequestedRef.current = false;
    }, 360);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(stabilizationTimer);
    };
  }, [spotIndex, fase, actionFlowEnabled]);

  const handleAction = (action, eventTimestamp = 0, options = {}) => {
    if (currentSpotIsLocked || !sequenceReady || (examMode && examProgress >= examLength)) return;
    const responseMs = Math.max(0, decisionElapsedMs);
    setDecisionElapsedMs(responseMs);
    const bucket = bucketOf(action);
    const correctBucket = bucketOf(analysis.exploitAction);
    const isAllinClose = correctBucket === "RAISE" && bucket === "ALLIN" && spot.heroStackBB <= 20;
    const baseAssessment = assessDecision(action, analysis);
    const assessment = options.timeout
      ? { ...baseAssessment, acceptable: false, grade: "TEMPO ESGOTADO", loss: Math.max(1, Number(baseAssessment.loss || 0)) }
      : baseAssessment;
    const correct = options.timeout ? false : assessment.acceptable || bucket === correctBucket || isAllinClose;
    setDecision({ action, correct, responseMs, timeout: !!options.timeout, ...assessment });
    setReviewUnlockedSpotKey(null);
    const recordTimestamp = eventTimestamp > 0
      ? Math.round((typeof performance !== "undefined" ? performance.timeOrigin : 0) + eventTimestamp)
      : Date.now();

    const record = {
      ts: recordTimestamp,
      // FASE ALEATÓRIO sorteia uma fase real por spot — o histórico grava a fase de fato
      // sorteada (spot.faseCfg.key), nunca o literal "ALEATORIO", pra manter o progresso por
      // fase e por posição corretos mesmo com o filtro em modo aleatório.
      fase: spot.faseCfg?.key || cfg.fase, street: spot.street, modalidade: cfg.modalidade, field: cfg.field, tableSize: cfg.tableSize, presetKey: cfg.preset?.key || null,
      stackFilter: cfg.stackFilterBB || null,
      responseMs: Math.round(responseMs), rigorMode, examMode,
      grade: assessment.grade, evLossBB: +assessment.loss.toFixed(2), chosenEVBB: +assessment.chosenEV.toFixed(2),
      heroInfo: spot.bankEntry ? spot.bankEntry.handType : spot.postflopEntry ? BUCKET_LABEL_PT[spot.postflopEntry.bucket] : "SPOT",
      scenario: spot.bankEntry ? spot.bankEntry.scenario : spot.postflopEntry ? spot.postflopEntry.bucket : null,
      position: spot.heroPosition, action, correctAction: analysis.exploitAction, correct, evBB: analysis.evBB,
      spotKey: currentSpotKey, timedOut: !!options.timeout,
    };
    if (examMode && examProgress + 1 >= examLength) finishExam([...history.slice(examStartIndex), record]);
    setHistory((h) => {
      const updated = [...h, record];
      appStorage.set("training-history", JSON.stringify(updated)).catch(() => {});
      return updated;
    });
    setReviewQueue((queue) => {
      let updated = [...queue];
      if (activeDueReview) {
        updated = updated.filter((review) => review.id !== activeDueReview.id);
        if (assessment.acceptable && activeDueReview.stage < 3) {
          const nextStage = activeDueReview.stage + 1;
          updated.push({
            ...activeDueReview,
            stage: nextStage,
            dueCount: nextStage === 1 ? history.length + 20 : null,
            dueAt: nextStage === 2 ? recordTimestamp + 86400000 : nextStage === 3 ? recordTimestamp + 7 * 86400000 : null,
          });
        } else if (!assessment.acceptable) {
          updated.push({ ...activeDueReview, dueCount: history.length + 5, dueAt: null });
        }
      } else if (!assessment.acceptable) {
        updated.push({
          id: `${recordTimestamp}-${cfg.fase}-${cfg.spotIndex}`,
          stage: 0,
          dueCount: history.length + 5,
          dueAt: null,
          cfg: { modalidade: cfg.modalidade, field: cfg.field, mix: cfg.mix, tableSize: cfg.tableSize, fase: cfg.fase, street: spot.street, spotIndex: cfg.spotIndex, presetKey: cfg.preset?.key || null },
        });
      }
      appStorage.set("spaced-review-queue", JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  };

  const reviewCurrentHand = () => {
    if (!decision && !currentSpotWasAnswered) return;
    setDecision(null);
    setReviewUnlockedSpotKey(currentSpotKey);
    setActionFlowEnabled(true);
    setActionPaused(false);
    setActionStep(-1);
    setSequenceReady(true);
    decisionStartedAtRef.current = performance.now();
    setDecisionElapsedMs(0);
    setShotClockRemaining(20);
  };

  const clearHistory = () => {
    if (history.length === 0) return;
    if (!window.confirm(`Apagar todo o histórico de treino (${history.length} spots)? Essa ação não pode ser desfeita.`)) return;
    setHistory([]);
    setAiReport(null);
    setAiReportError(null);
    appStorage.set("training-history", JSON.stringify([])).catch(() => {});
  };

  function buildHistorySummary() {
    const total = history.length;
    const acertos = history.filter((h) => h.correct).length;
    const pct = total > 0 ? ((acertos / total) * 100).toFixed(1) : "0.0";
    const header = `HISTÓRICO DE TREINO — STACKUP HOLD'EM PRO\nTotal de spots: ${total} | Acertos: ${acertos} (${pct}%)\n\nÚLTIMAS DECISÕES:\n`;
    const lastEntries = history.slice(-30).reverse().map((h, i) => {
      const d = new Date(h.ts).toLocaleString("pt-BR");
      return `${i + 1}. [${d}] ${faseDisplayLabel(h.fase)} / ${h.street} / ${h.position} / ${h.scenario || "-"} — ${h.heroInfo} — Escolhido: ${h.action} | Referência: ${h.correctAction} (EV ${h.evBB >= 0 ? "+" : ""}${h.evBB} BB) — ${h.grade || (h.correct ? "MELHOR DECISÃO" : "ERRO")} — perda ${Number(h.evLossBB || 0).toFixed(2)} BB`;
    }).join("\n");
    return header + lastEntries;
  }

  const sendHistoryWhatsapp = () => {
    const text = encodeURIComponent(buildHistorySummary());
    const phone = userWhatsapp.replace(/\D/g, "");
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, "_blank");
  };

  const sendHistoryEmail = () => {
    const subject = encodeURIComponent("Histórico de treino — STACKUP HOLD'EM PRO");
    const body = encodeURIComponent(buildHistorySummary());
    window.location.href = `mailto:${userEmail}?subject=${subject}&body=${body}`;
  };

  const heroSeat = spot.seats.find((seat) => seat.isHero);
  const heroCommittedBB = Number(heroSeat?.betBB || 0);
  const currentBetBB = Number(spot.currentBet || 0) / spot.bb;
  const minimumRaiseBB = Math.min(
    spot.heroStackBB,
    spot.facingBet
      ? currentBetBB + Math.max(1, currentBetBB - heroCommittedBB)
      : spot.street === "PRE-FLOP" ? 2 : 1
  );
  const isPreflopDecision = spot.street === "PRE-FLOP";
  const preflopRaiseName = ["FACING_RAISE", "RESHOVE", "SQUEEZE", "LIMP_RAISE"].includes(spot.bankEntry?.scenario)
    ? "3-BET"
    : spot.bankEntry?.scenario === "FACING_3BET"
      ? (spot.bankEntry.preflopLevel === 4 ? "5-BET" : "4-BET")
      : "RAISE";
  const heroScenario = spot.bankEntry?.scenario;
  const heroTurnLabel = !isPreflopDecision
    ? (spot.facingBet ? "RAISE MÍN." : "BET MÍN.")
    : heroScenario === "OPEN_SHOVE" ? "ALL-IN"
    : heroScenario === "FACING_SHOVE" ? "CALL / FOLD"
    : heroScenario === "RESHOVE" ? "RESHOVE"
    : heroScenario === "SQUEEZE" ? "SQUEEZE"
    : heroScenario === "ISOLATE_LIMPERS" ? "ISO RAISE"
    : heroScenario === "RFI" ? "RFI MÍN."
    : `${preflopRaiseName} MÍN.`;
  const heroPromptColor = heroScenario === "OPEN_SHOVE" || heroScenario === "RESHOVE"
    ? actionSeatColor("ALL IN")
    : heroScenario === "FACING_SHOVE" ? actionSeatColor("CALL")
    : ["FACING_RAISE", "SQUEEZE", "LIMP_RAISE"].includes(heroScenario) ? actionSeatColor("3-BET")
    : heroScenario === "FACING_3BET" ? actionSeatColor("4-BET")
    : actionSeatColor("RAISE");
  const raiseButtonColor = "#22C55E"; // fileira 2 (RAISE) é sempre verde, sem variação por 3-bet/4-bet
  const preflopRaiseNameDisplay = preflopRaiseName.replace("-", "");
  const formatFactor = (factor) => String(factor).replace(".", ",");
  const raiseFactors = spot.bankEntry?.scenario === "FACING_3BET" ? [2, 2.25, 2.5] : [2, 2.5, 3];
  // Fileira 2 (RAISE/RAISE/RAISE): sempre exatamente 3 botões, verdes, independente do
  // contexto (antes variava entre 2 e 3 dependendo da street/cenário).
  const raiseButtons = spot.postflopEntry?.strategicNode === "BLOCK_BET_RIVER"
    ? [0.20, 0.25, 0.33].map((fraction) => {
        const amountBB = Math.min(spot.heroStackBB, Math.max(0.1, (spot.pot / spot.bb) * fraction));
        return { key: `RAISE-${Math.round(fraction * 100)}`, label: `BLOCK ${Math.round(fraction * 100)}%`, value: `${amountBB.toFixed(1)} BB`, color: raiseButtonColor };
      })
    : isPreflopDecision
    ? raiseFactors.map((factor) => {
        return { key: `RAISE-${factor}X`, label: `${preflopRaiseNameDisplay} ${formatFactor(factor)}X`, value: "", color: raiseButtonColor };
      })
    : spot.facingBet
      ? [2, 2.5, 3].map((factor) => {
          return { key: `RAISE-${factor}X`, label: `RAISE ${formatFactor(factor)}X`, value: "", color: raiseButtonColor };
        })
      : [0.33, 0.5, 0.75].map((fraction) => {
          const amountBB = Math.min(spot.heroStackBB, Math.max(minimumRaiseBB, (spot.pot / spot.bb) * fraction));
          return { key: `RAISE-${Math.round(fraction * 100)}`, label: `BET ${Math.round(fraction * 100)}%`, value: `${amountBB.toFixed(1)} BB`, color: raiseButtonColor };
        });
  // Fileira 3 (SQUEEZE / OVER BET / SHOVE): sempre presente, tamanhos maiores que a fileira 2.
  // SQUEEZE = re-raise agressivo (isola contra abertura + pagador — no pré-flop, ~4x o que
  // precisa pagar; sem equivalente direto pós-flop, mas mantém a grade fixa com um tamanho
  // grande de aposta). OVER BET = aposta/raise que ultrapassa o tamanho do pote (>100% pot),
  // conceito bem mais simples de calcular que exigir saber quem foi o agressor da rua anterior.
  const squeezeAmountBB = Math.min(spot.heroStackBB, Math.max(minimumRaiseBB, isPreflopDecision ? currentBetBB * 4 : (spot.pot / spot.bb) * 1.0));
  const overBetAmountBB = Math.min(spot.heroStackBB, Math.max(minimumRaiseBB, isPreflopDecision ? currentBetBB * 6 : (spot.pot / spot.bb) * 1.25));
  const bigBetButtons = [
    { key: "RAISE-SQUEEZE", label: "SQUEEZE", value: `${squeezeAmountBB.toFixed(1)} BB`, color: "#EC4899" },
    { key: "RAISE-OVERBET", label: "OVER BET", value: `${overBetAmountBB.toFixed(1)} BB`, color: "#F97316" },
    { key: "ALL IN", label: "SHOVE", value: "", color: "#FACC15" },
  ];
  // Mostra todo mundo envolvido na mão até aqui (quem já teve chance de agir antes do herói +
  // blinds + o vilão real do spot) — a contagem varia sozinha (2 a 9) conforme a posição do
  // herói e a ação do spot; o tamanho de mesa selecionado não entra mais nessa conta (ver
  // TABLE_SIZE_POSITIONS/filterBankByTableSize, que agora só filtram a simulação/treino).
  const involvedPositions = computeInvolvedPositions(spot);
  const allowedTablePositions = TABLE_SIZE_POSITIONS[tableSize] || TABLE_SIZE_POSITIONS[10];
  const visibleSeats = spot.seats.map((s) => ({
    ...s,
    isInvolved: s.isHero || involvedPositions.has(s.pos),
    isAtTable: allowedTablePositions.has(s.pos),
  }));

  // Assentos fixos no sentido horário. O rodízio agora é relativo ao herói: onde quer que ele
  // esteja sentado de verdade naquela mão (SB, BB, UTG...), o card dele sempre aparece no MESMO
  // slot fixo da grade (índice 1 = coluna 2, linha 1 — logo abaixo do card grande de HERÓI, pra
  // facilitar a visualização). As demais posições continuam girando ao redor dele na sequência
  // correta (sentido horário) e mantêm sua cor de posição normal (SB/BB vermelho, etc.) — a cor
  // depende do nome da posição, não do slot da grade, então não muda com este rodízio.
  const clockwisePositions = ["SB", "BB", "UTG", "UTG1", "MP", "MP1", "LJ", "HJ", "CO", "BTN"];
  // Rodízio horário: cruza o topo, desce pela direita, cruza a base e sobe pela esquerda.
  const clockwiseGrid = [
    { gridRow: 1, gridColumn: 1, inRotation: true },
    { gridRow: 1, gridColumn: 2, inRotation: true },
    { gridRow: 2, gridColumn: 2, inRotation: true },
    { gridRow: 3, gridColumn: 2, inRotation: true },
    { gridRow: 4, gridColumn: 2, inRotation: true },
    { gridRow: 5, gridColumn: 2, inRotation: true },
    { gridRow: 5, gridColumn: 1, inRotation: true },
    { gridRow: 4, gridColumn: 1, inRotation: true },
    { gridRow: 3, gridColumn: 1, inRotation: true },
    { gridRow: 2, gridColumn: 1, inRotation: true },
  ];
  const HERO_FIXED_GRID_INDEX = 1; // c2L1
  const heroClockwiseIndex = clockwisePositions.indexOf(spot.heroPosition);
  const gridIndexForPosition = (pos) => {
    const posIndex = clockwisePositions.indexOf(pos);
    if (heroClockwiseIndex < 0 || posIndex < 0) return posIndex >= 0 ? posIndex : 0;
    return (HERO_FIXED_GRID_INDEX + (posIndex - heroClockwiseIndex) + clockwisePositions.length) % clockwisePositions.length;
  };
  const clockwiseSeats = clockwisePositions.map((pos) => {
    const seat = visibleSeats.find((s) => s.pos === pos);
    return { ...seat, ...clockwiseGrid[gridIndexForPosition(pos)], clockwiseIndex: gridIndexForPosition(pos) };
  });

  // Mesma mesa visual do treino (clockwisePositions/clockwiseGrid), populada com o retrato real
  // do torneio (torneioSeats) em vez do spot de treino desconectado. O torneio é sempre 9-max
  // (sem MP1) — a posição MP1 simplesmente não existe em torneioSeats e o slot dela fica vazio.
  const torneioHeroClockwiseIndex = clockwisePositions.indexOf(torneioSeats?.find((s) => s.isHero)?.pos);
  const torneioGridIndexForPosition = (pos) => {
    const posIndex = clockwisePositions.indexOf(pos);
    if (torneioHeroClockwiseIndex < 0 || posIndex < 0) return posIndex >= 0 ? posIndex : 0;
    return (HERO_FIXED_GRID_INDEX + (posIndex - torneioHeroClockwiseIndex) + clockwisePositions.length) % clockwisePositions.length;
  };
  const torneioClockwiseSeats = torneioMode && torneioSeats
    ? clockwisePositions.map((pos) => {
        const seat = torneioSeats.find((s) => s.pos === pos);
        if (!seat) return null;
        const bb = torneioInfo?.bb || 0;
        return {
          pos,
          isHero: seat.isHero,
          isActionActive: false,
          isInvolved: !seat.folded,
          opacity: seat.folded ? 0.35 : 1,
          displayAction: seat.folded ? "FOLD" : seat.isHero ? "AGUARDANDO" : (seat.committedBB > 0 ? `${seat.committedBB.toFixed(1)} BB` : "---"),
          displayBetChips: Math.round(seat.committedBB * bb),
          displayBetBB: seat.committedBB,
          stackChips: Math.round(seat.stackBB * bb),
          stackBB: seat.stackBB,
          ...clockwiseGrid[torneioGridIndexForPosition(pos)],
        };
      }).filter(Boolean)
    : null;
  // A animação segue a ordem real de ação e ignora posições que não existem na
  // estrutura selecionada. O último estado é sempre a vez do herói decidir.
  const actionSequence = useMemo(
    () => buildActionTimeline(spot).filter((event) => allowedTablePositions.has(event.pos)),
    [spot, allowedTablePositions],
  );
  const playActionSound = useCallback((action) => {
    if (!soundEnabled || typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = audioContextRef.current || new AudioCtx();
      audioContextRef.current = ctx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      const now = ctx.currentTime;
      const rand = (min, max) => min + Math.random() * (max - min);
      // Ganho geral: os níveis abaixo foram calibrados bem baixos pra evitar estridência, mas
      // ficaram baixos demais na prática — multiplica tudo (som direto + envio pra reverb) de
      // uma vez só, mantendo o equilíbrio relativo entre as camadas de cada som.
      const MASTER_VOLUME = 2.2;

      // Reverberação curta e barata (impulso de ruído com decaimento exponencial) — é o que
      // mais separa uma síntese "de laboratório" de um som que parece vindo de uma mesa de
      // verdade. Reconstrói o buffer só na primeira vez por AudioContext (fica em cache no
      // ref); todo som depois manda uma fração discreta pro convolver via sendReverb.
      let reverbBus = reverbNodeRef.current;
      if (!reverbBus || reverbBus.ctx !== ctx) {
        const convolver = ctx.createConvolver();
        const duration = 0.5;
        const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const data = impulse.getChannelData(ch);
          let seed = (0x2545f491 ^ (ch * 0x9e3779b9)) >>> 0;
          for (let i = 0; i < length; i++) {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            const white = ((seed >>> 0) / 4294967295) * 2 - 1;
            data[i] = white * Math.pow(1 - i / length, 2.8);
          }
        }
        convolver.buffer = impulse;
        convolver.connect(ctx.destination);
        reverbBus = { ctx, convolver };
        reverbNodeRef.current = reverbBus;
      }
      const sendReverb = (node, amount) => {
        if (amount <= 0) return;
        const send = ctx.createGain();
        send.gain.value = amount;
        node.connect(send);
        send.connect(reverbBus.convolver);
      };

      const tone = (frequency, delay, duration, volume, type = "sine", endFrequency = frequency, wet = 0.08) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(frequency, now + delay);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + delay + duration);
        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(volume * MASTER_VOLUME, now + delay + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
        osc.connect(gain); gain.connect(ctx.destination);
        sendReverb(gain, wet * MASTER_VOLUME);
        osc.start(now + delay); osc.stop(now + delay + duration + 0.02);
      };
      const noise = (delay, duration, volume, filterType, startFrequency, endFrequency, wet = 0.1, q = 1) => {
        const frameCount = Math.max(1, Math.floor(ctx.sampleRate * duration));
        const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        // Ruído branco por xorshift: sem o tom metálico artificial produzido por ondas periódicas.
        // A semente varia com o delay pra duas camadas do mesmo evento nunca soarem clonadas.
        let noiseSeed = (0x6d2b79f5 ^ Math.floor(delay * 1e6)) >>> 0;
        for (let i = 0; i < frameCount; i++) {
          noiseSeed ^= noiseSeed << 13;
          noiseSeed ^= noiseSeed >>> 17;
          noiseSeed ^= noiseSeed << 5;
          data[i] = ((noiseSeed >>> 0) / 4294967295) * 2 - 1;
        }
        const source = ctx.createBufferSource();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        source.buffer = buffer;
        filter.type = filterType;
        filter.Q.value = q;
        filter.frequency.setValueAtTime(startFrequency, now + delay);
        filter.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), now + delay + duration);
        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(volume * MASTER_VOLUME, now + delay + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
        source.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
        sendReverb(gain, wet * MASTER_VOLUME);
        source.start(now + delay); source.stop(now + delay + duration + 0.02);
      };

      // Ficha pousando/batendo em outra: um clique curto e brilhante (a casca cerâmica) somado
      // a um corpo mais grave logo atrás (a ressonância do disco). Cada chamada recebe jitter
      // de tom/tempo/volume — fichas reais nunca soam duas vezes exatamente iguais, e é
      // justamente essa repetição perfeita que denuncia uma síntese como artificial.
      const chipClick = (delay, weight = 1, brightness = 1) => {
        const clickFreq = 2600 * brightness * rand(0.92, 1.08);
        noise(delay, rand(0.012, 0.018), (0.02 + weight * 0.01) * rand(0.85, 1.15), "bandpass", clickFreq, clickFreq * 0.55, 0.14, 2.4);
        tone(rand(210, 260), delay + rand(0.001, 0.004), rand(0.035, 0.05), (0.02 + weight * 0.012) * rand(0.8, 1.2), "triangle", rand(90, 130), 0.1);
      };

      const normalized = String(action || "").toUpperCase();
      if (normalized === "TIME WARNING") {
        // Alerta curto e inequívoco aos cinco segundos finais — sinal de UI, não da mesa, por
        // isso fica seco (sem reverb).
        tone(880, 0, 0.09, 0.045, "sine", 880, 0);
        tone(1040, 0.14, 0.11, 0.05, "sine", 1040, 0);
      } else if (normalized === "CHECK") {
        // Duas batidas de nó do dedo na mesa: corpo grave amortecido + leve abafamento, nunca
        // duas batidas idênticas.
        [0, 0.15 + rand(-0.012, 0.012)].forEach((delay, index) => {
          noise(delay, rand(0.045, 0.06), (index ? 0.03 : 0.038) * rand(0.85, 1.15), "lowpass", rand(560, 680), rand(200, 260), 0.12);
          tone(rand(70, 96) * (index ? 0.82 : 1), delay, rand(0.05, 0.065), (index ? 0.044 : 0.056) * rand(0.85, 1.15), "triangle", rand(46, 58), 0.08);
        });
      } else if (normalized === "FOLD") {
        // Carta flicada/deslizando no feltro: ruído com "flutter" (a ondulação de uma carta
        // fina cortando o ar), seguido do assentamento abafado sobre a mesa — sem nenhuma nota
        // afinada, sem apito.
        const flutterHz = rand(24, 34);
        const flutterDuration = 0.22;
        const frameCount = Math.max(1, Math.floor(ctx.sampleRate * flutterDuration));
        const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let seed = 0x51ed270b;
        for (let i = 0; i < frameCount; i++) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          const white = ((seed >>> 0) / 4294967295) * 2 - 1;
          const t = i / ctx.sampleRate;
          const flutter = 0.5 + 0.5 * Math.sin(2 * Math.PI * flutterHz * t);
          data[i] = white * flutter;
        }
        const source = ctx.createBufferSource();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        source.buffer = buffer;
        filter.type = "bandpass";
        filter.Q.value = 0.7;
        filter.frequency.setValueAtTime(1150, now);
        filter.frequency.exponentialRampToValueAtTime(300, now + flutterDuration);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.03 * MASTER_VOLUME, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + flutterDuration);
        source.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
        sendReverb(gain, 0.1 * MASTER_VOLUME);
        source.start(now); source.stop(now + flutterDuration + 0.02);
        noise(0.03, 0.13, 0.01, "lowpass", 480, 160, 0.08);
      } else if (normalized === "CALL" || normalized === "LIMP") {
        // Duas fichas pousando — mesmo vocabulário sonoro de um raise, só mais contido: um call
        // nunca deve soar tão "grande" quanto um aumento de verdade.
        chipClick(0, 0.7, 1.05);
        chipClick(rand(0.08, 0.1), 0.65, 0.95);
      } else {
        // Ações agressivas: pilha de fichas sendo empurrada — vários chipClick com tempo e tom
        // levemente irregulares (fichas reais nunca caem em intervalos matematicamente iguais),
        // fechando com o impacto grave da pilha pousando no feltro.
        const aggressionLevel = normalized.includes("ALL") ? 5
          : normalized.includes("5-BET") ? 5
          : normalized.includes("4-BET") ? 4
          : normalized.includes("3-BET") ? 3
          : normalized.includes("RAISE") ? 2
          : 1;
        const chipCount = 3 + aggressionLevel;
        let cursor = 0;
        for (let index = 0; index < chipCount; index++) {
          cursor += rand(0.026, 0.05);
          const weight = Math.max(0.4, 0.75 + aggressionLevel * 0.08 - index * 0.015);
          chipClick(cursor, weight, rand(0.85, 1.15));
        }
        // Pilha inteira pousando no feltro — mais grave e mais presente quanto maior a aposta.
        noise(cursor + 0.02, 0.1 + aggressionLevel * 0.02, 0.01 + aggressionLevel * 0.0022, "lowpass", 380 + aggressionLevel * 40, 120, 0.16);
        tone(rand(58, 72), cursor + 0.025, 0.12 + aggressionLevel * 0.015, 0.012 + aggressionLevel * 0.0018, "sine", 40, 0.14);
      }
    } catch { /* áudio é apenas um reforço opcional */ }
  }, [soundEnabled]);

  const beginActionSequence = () => {
    setActionFlowEnabled(true);
    setSequenceReady(false);
    setActionStep(-1);
    setActionPaused(false);
    lastSoundedStepRef.current = -1;
    setShotClockRemaining(20);
    setDecision(null);
    if (soundEnabled && typeof window !== "undefined") {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx && !audioContextRef.current) audioContextRef.current = new AudioCtx();
      } catch { /* som opcional */ }
    }
    // Ao clicar em INICIAR, a tela rola sozinha até o card do POT ficar preso na
    // borda superior da tela (block:"start", não mais "center") — dá pra acompanhar board/herói/
    // mesa/botões de ação sem precisar rolar de novo. Marca a mesma referência usada por
    // ANTERIOR/PRÓXIMO pra que os efeitos mais abaixo (que também tentam corrigir o scroll
    // conforme o layout se estabiliza) saibam que essa mudança veio de navegação de verdade —
    // não de um filtro (fase/street/posição/stack) sendo ativado ou desativado.
    gameFocusRequestedRef.current = true;
    potSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => setActionStep(0), 220);
  };

  // Encerra a sequência/rodada atual (botão vira FINALIZAR enquanto actionFlowEnabled é
  // verdadeiro) — desliga actionFlowEnabled, o que já faz o efeito de reset acima (dependente
  // de actionFlowEnabled) devolver actionStep/sequenceReady/actionPaused ao estado inicial sem
  // reiniciar a animação; volta a mostrar cartas/stacks ocultos, como antes do primeiro INICIAR.
  const endActionSequence = () => {
    setActionFlowEnabled(false);
    setSequenceReady(false);
    setActionStep(-1);
    setActionPaused(false);
    setDecision(null);
    lastSoundedStepRef.current = -1;
    setShotClockRemaining(20);
  };

  // REPETIR SPOTS: reinicia o treino (volta pro primeiro spot) mantendo sessionStart/
  // sessionStepRaw/sessionSeed intactos — como esses três só são sorteados uma vez, ao montar
  // o app, e nunca mudam durante a sessão, é exatamente esse trio que determina, de forma
  // determinística, qual sequência de spots aparece pra cada combinação de fase/street/posição/
  // preset. Voltar spotIndex pra 1 sem mexer neles faz os MESMOS spots já vistos reaparecerem,
  // na mesma ordem, em vez de sortear uma sequência nova — é essa a diferença pro botão
  // INICIAR/FINALIZAR, que não mexe no progresso, só liga/desliga o fluxo de ações do spot atual.
  const repeatSpots = () => {
    endActionSequence();
    setSpotIndex(1);
    setSessionCompleteNotice(false);
    resetHuSession();
  };

  // Depois do primeiro INICIAR, cada novo spot reproduz automaticamente a ação até o herói —
  // exceto quando ANTERIOR/PRÓXIMO leva de volta a um spot que já foi respondido antes: nesse
  // caso a mão deve aparecer direto CONGELADA pra revisão (sequência inteira já revelada, sem
  // reanimar do zero, e a decisão antiga restaurada — o que também trava os botões de ação via
  // currentSpotIsLocked e realça o botão que foi escolhido na época). Só volta a reanimar do
  // zero se o spot for reaberto de propósito depois (REVER MÃO, que limpa reviewUnlockedSpotKey
  // pro valor da mão atual) ou se for um spot realmente novo, nunca respondido.
  useEffect(() => {
    if (actionFlowEnabled && !decision && currentSpotWasAnswered && reviewUnlockedSpotKey !== currentSpotKey) {
      const pastRecord = history.find((entry) => entry.spotKey === currentSpotKey);
      setActionPaused(false);
      setSequenceReady(true);
      setActionStep(actionSequence.length);
      if (pastRecord) {
        const pastAssessment = assessDecision(pastRecord.action, analysis);
        setDecision({ action: pastRecord.action, correct: pastRecord.correct, responseMs: pastRecord.responseMs, timeout: !!pastRecord.timedOut, ...pastAssessment });
      }
      if (gameFocusRequestedRef.current) {
        potSectionRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
        gameFocusRequestedRef.current = false;
      }
      return;
    }
    const resetTimer = window.setTimeout(() => {
      setSequenceReady(false);
      setActionStep(-1);
      setActionPaused(false);
      lastSoundedStepRef.current = -1;
      setShotClockRemaining(20);
    }, 0);
    if (!actionFlowEnabled) return () => window.clearTimeout(resetTimer);
    const focusTimer = window.setTimeout(() => {
      // O scroll pro POT só deve acontecer quando a mudança de spot veio de uma navegação de
      // verdade (INICIAR já cuida do seu próprio scroll acima; ANTERIOR/PRÓXIMO marcam
      // gameFocusRequestedRef antes de chegar aqui) — nunca quando um filtro (fase/street/
      // posição/stack) muda o spot como efeito colateral de ativar/desativar uma opção.
      if (gameFocusRequestedRef.current) potSectionRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
      setActionStep(0);
    }, 260);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(focusTimer);
    };
    // Deps propositalmente restritas à mudança REAL de spot (navegação/filtro) — nunca a
    // `history`/`decision`/`currentSpotWasAnswered`/`currentSpotKey`/`reviewUnlockedSpotKey`/
    // `analysis`/`actionSequence`. BUG CORRIGIDO: essas variáveis chegaram a entrar aqui pra
    // alimentar o ramo "congelar spot já respondido" acima, mas como `history` muda a CADA
    // handleAction (mesmo sem trocar de spot), esse efeito inteiro — inclusive o resetTimer/
    // focusTimer que reanimam a sequência de ações do zero — reexecutava logo após o herói
    // decidir, ainda na mesma mão, antes de qualquer clique em PRÓXIMO. Na prática a mesa
    // parecia "regerar"/repetir o spot sozinha. As variáveis extras continuam lidas aqui dentro
    // (closure), só não disparam mais o efeito sozinhas — no momento em que spotIndex/fase/
    // street/activePresetKey realmente mudam (navegação de verdade), elas já estão atualizadas
    // pro spot novo, então o ramo "congelar" acima continua funcionando normalmente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotIndex, fase, street, activePresetKey, actionFlowEnabled]);

  useEffect(() => {
    if (actionStep < 0) return;
    if (actionStep >= actionSequence.length) {
      const readyTimer = window.setTimeout(() => {
        decisionStartedAtRef.current = performance.now();
        setShotClockRemaining(20);
        setDecisionElapsedMs(0);
        setSequenceReady(true);
        // Correção final: com o board/herói/mesa/botões já totalmente revelados (sem mais
        // mudança de altura pela frente), garante o POT realmente preso na borda superior —
        // as duas chamadas anteriores (clique em INICIAR + início da sequência) já aproximam,
        // mas layout ainda muda durante a revelação das ações dos adversários. Só quando a
        // mudança veio de navegação de verdade (INICIAR/ANTERIOR/PRÓXIMO) — nunca por causa de
        // um filtro sendo ativado/desativado, que também reinicia essa mesma sequência de
        // revelação como efeito colateral.
        if (gameFocusRequestedRef.current) {
          potSectionRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
          gameFocusRequestedRef.current = false;
        }
      }, 0);
      return () => window.clearTimeout(readyTimer);
    }
    if (actionPaused) return;
    if (lastSoundedStepRef.current !== actionStep) {
      playActionSound(actionSequence[actionStep].action);
      lastSoundedStepRef.current = actionStep;
    }
    // Jogador que dá fold: a linha aparece completa, fica parada 1s (baseDelay) e só então anda
    // pra fora do card inteira, deslizando da esquerda pra direita (ver .nlh-log-row-fold /
    // nlhLogRowWalkOut no CSS). FOLD_WALK_OUT_MS soma ao delay antes de avançar o actionStep —
    // tempo fixo, não escalado por actionSpeed — pra linha só sumir da lista quando a animação
    // de saída já tiver terminado, sem "puxar o tapete" no meio do movimento.
    const isFoldStep = actionSequence[actionStep].action === "FOLD";
    const baseDelay = Math.round(1000 / actionSpeed);
    const FOLD_WALK_OUT_MS = 400;
    const timer = window.setTimeout(() => setActionStep((step) => step + 1), isFoldStep ? baseDelay + FOLD_WALK_OUT_MS : baseDelay);
    return () => window.clearTimeout(timer);
  }, [actionStep, actionSequence, actionPaused, actionSpeed, playActionSound]);

  useEffect(() => {
    if (!sequenceReady || decision) return;
    const timer = window.setInterval(() => {
      if (decisionStartedAtRef.current != null) setDecisionElapsedMs(performance.now() - decisionStartedAtRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, [sequenceReady, decision, spotIndex]);

  // Modo Prova: cronômetro de 15s automático e obrigatório em todo spot — não existe mais uma
  // trava manual pra ligar/desligar; fora do Modo Prova não há cronômetro nenhum.
  useEffect(() => {
    if (!examMode || !sequenceReady || decision) return;
    setShotClockRemaining(20);
    const timer = window.setInterval(() => setShotClockRemaining((remaining) => Math.max(0, remaining - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [examMode, sequenceReady, decision, spotIndex]);

  const handleActionRef = useRef(handleAction);
  useEffect(() => {
    handleActionRef.current = handleAction;
  });
  useEffect(() => {
    if (!examMode || !sequenceReady || decision) return;
    if (shotClockRemaining >= 1 && shotClockRemaining <= 5) playActionSound("TIME WARNING");
    if (shotClockRemaining === 0) handleActionRef.current("FOLD", 0, { timeout: true });
  }, [examMode, sequenceReady, decision, shotClockRemaining, playActionSound]);

  // Relógio de ação do Modo Torneio: 20s por decisão — reseta a cada nova decisão pendente
  // (torneioContext muda de identidade a cada vez que uma decisão nova aparece). Esgotado o
  // tempo, a mão é considerada FOLD automaticamente e avança pra próxima, sem esperar clique.
  useEffect(() => {
    if (!torneioMode || !torneioContext) return;
    const resetTimer = window.setTimeout(() => setShotClockRemaining(20), 0);
    const timer = window.setInterval(() => setShotClockRemaining((remaining) => Math.max(0, remaining - 1)), 1000);
    return () => { window.clearTimeout(resetTimer); window.clearInterval(timer); };
  }, [torneioMode, torneioContext]);

  const handleTorneioActionRef = useRef(null);
  useEffect(() => {
    handleTorneioActionRef.current = handleTorneioAction;
  });
  useEffect(() => {
    if (!torneioMode || !torneioContext) return;
    if (shotClockRemaining === 0) handleTorneioActionRef.current?.("FOLD");
  }, [torneioMode, torneioContext, shotClockRemaining]);

  const animatedSeats = clockwiseSeats.map((p) => {
    const forcedBlindBB = spot.street === "PRE-FLOP" ? (p.pos === "BB" ? 1 : p.pos === "SB" ? 0.5 : 0) : 0;
    const activeEvent = actionStep >= 0 && actionStep < actionSequence.length && actionSequence[actionStep].pos === p.pos
      ? actionSequence[actionStep]
      : null;
    const completedEvents = actionSequence.filter((event, index) => event.pos === p.pos && (sequenceReady || index < actionStep));
    const latestEvent = completedEvents[completedEvents.length - 1] || null;
    const displayEvent = activeEvent || latestEvent;
    const isActionActive = !!activeEvent;
    const isActionCompleted = !!latestEvent || sequenceReady;
    if (p.isHero) {
      return {
        ...p,
        isActionActive,
        isActionCompleted,
        displayAction: sequenceReady ? heroTurnLabel : displayEvent?.action || "AGUARDANDO",
        displayBetBB: displayEvent?.betBB ?? forcedBlindBB,
        displayBetChips: displayEvent?.betChips ?? Math.round(forcedBlindBB * spot.bb),
        opacity: 1,
        visualColor: HERO_SEAT_COLOR,
      };
    }
    // Pré-flop todos começam abertos. Nas demais streets, quem não pertence ao
    // conjunto de participantes já foldou e permanece opaco desde o início.
    const foldedBeforeStreet = spot.street !== "PRE-FLOP" && p.isAtTable && !p.isInvolved && !displayEvent;
    const currentAction = displayEvent?.action || (foldedBeforeStreet ? "FOLD" : null);
    const folded = foldedBeforeStreet || (!!displayEvent && currentAction === "FOLD");
    const stayedInHand = !!latestEvent && currentAction !== "FOLD";
    const visualColor = folded ? "#6B7280" : (p.isAtTable || p.isInvolved || displayEvent) ? VILLAIN_SEAT_COLOR : INACTIVE_SEAT_COLOR;
    // No pré-flop todos abrem; depois, somente os participantes da street ficam abertos.
    const opacity = isActionActive ? 1 : folded ? 0.5 : p.isAtTable ? 1 : p.isInvolved ? 1 : 0.06;
    return {
      ...p,
      isInvolved: p.isInvolved || stayedInHand || isActionActive,
      isActionActive,
      isActionCompleted,
      displayAction: currentAction || "---",
      displayBetBB: displayEvent?.betBB ?? forcedBlindBB,
      displayBetChips: displayEvent?.betChips ?? Math.round(forcedBlindBB * spot.bb),
      opacity,
      visualColor,
    };
  });

  // Card único de log de ação (substitui os cards fixos por posição/rodízio): em vez de um
  // slot fixo por posição que a "vez" visita várias vezes ao longo da mesa, cada evento de
  // actionSequence vira uma linha cronológica nova, na ordem real em que aconteceu. Um FOLD
  // nunca "gruda" numa linha — aparece por um instante (dispara o som e a animação de saída
  // já existentes), some da esquerda pra direita e nunca entra no histórico rolável; só ações
  // que travam a rodada (limp/call/check/raise/bet/all-in) ficam registradas de vez. Isso
  // reaproveita o mesmo actionStep/actionSequence/sequenceReady que já dirige o card antigo —
  // não há novo motor de tempo, só uma leitura diferente do mesmo estado.
  //
  // Cada linha usa event.betBB/event.betChips (o total daquele evento específico, não o
  // "último evento da posição") pra calcular o stack no momento — necessário porque, em
  // cenários FACING_3BET, a mesma posição pode aparecer duas vezes na sequência (limpa e,
  // numa segunda volta, paga a 3-bet); usar o estado "mais recente" do assento faria a
  // primeira linha (já fixada) mudar de valor retroativamente quando a segunda acontecesse.
  //
  // Sem dado de streets anteriores no banco de spots (buildActionTimeline só reconstrói a
  // street atual) — o log começa vazio a cada nova street, não porque foi resetado de
  // propósito, mas porque é tudo que existe pra mostrar.
  const actionLogFixedRows = [];
  let actionLogActiveRow = null;
  if (!torneioMode) {
    for (let idx = 0; idx < actionSequence.length; idx++) {
      const isCompleted = sequenceReady || idx < actionStep;
      const isActive = !sequenceReady && idx === actionStep;
      if (!isCompleted && !isActive) break;
      const event = actionSequence[idx];
      const seat = animatedSeats.find((s) => s.pos === event.pos);
      if (!seat) continue;
      const committedChips = Number(event.betChips || 0);
      const committedBB = Number(event.betBB || 0);
      const paidAnteBB = spot.street === "PRE-FLOP" && event.pos === "BB" ? Number((spot.ante || spot.bb) / spot.bb) : 0;
      const paidAnteChips = paidAnteBB * spot.bb;
      const row = {
        key: `${idx}-${event.pos}-${event.action}`,
        pos: event.pos,
        action: event.action,
        stackChips: Math.max(0, Number(seat.stackChips || 0) - committedChips - paidAnteChips),
        stackBB: Math.max(0, Number(seat.stackBB || 0) - committedBB - paidAnteBB),
      };
      if (isActive) {
        actionLogActiveRow = row;
      } else if (event.action !== "FOLD") {
        actionLogFixedRows.push(row);
      }
    }
  }
  // Assim que chega a vez do herói (sequenceReady), ele ganha sua própria linha na lista —
  // obrigatória, aparece ANTES de qualquer clique de decisão, só pra deixar claro "agora é a
  // vez dele". Não é um evento de actionSequence (o herói pendente nunca é — só decisões
  // anteriores dele numa mesma street, se houver, já viraram linha fixa no loop acima); por
  // isso é calculada à parte, igual à mesma fonte de stack/posição usada em animatedSeats.
  let heroLogRow = null;
  if (!torneioMode && sequenceReady) {
    const heroSeat = animatedSeats.find((s) => s.isHero);
    if (heroSeat) {
      const committedChips = Number(heroSeat.displayBetChips || 0);
      const committedBB = Number(heroSeat.displayBetBB || 0);
      const paidAnteBB = spot.street === "PRE-FLOP" && heroSeat.pos === "BB" ? Number((spot.ante || spot.bb) / spot.bb) : 0;
      const paidAnteChips = paidAnteBB * spot.bb;
      heroLogRow = {
        key: "hero-pending",
        pos: heroSeat.pos,
        action: heroTurnLabel,
        isHero: true,
        stackChips: Math.max(0, Number(heroSeat.stackChips || 0) - committedChips - paidAnteChips),
        stackBB: Math.max(0, Number(heroSeat.stackBB || 0) - committedBB - paidAnteBB),
      };
    }
  }
  const actionLogVisibleRows = heroLogRow
    ? [...actionLogFixedRows, heroLogRow]
    : actionLogActiveRow
      ? [...actionLogFixedRows, actionLogActiveRow]
      : actionLogFixedRows;
  const actionLogRowCount = actionLogVisibleRows.length;
  const actionLogLastKey = actionLogActiveRow?.key ?? actionLogFixedRows[actionLogFixedRows.length - 1]?.key ?? null;

  // Acompanha o final do log automaticamente conforme novas linhas chegam (igual a um chat) —
  // o usuário ainda pode rolar pra cima manualmente pra rever o início da street a qualquer
  // momento; a rolagem automática só reancora quando uma linha nova de fato aparece/muda.
  useEffect(() => {
    if (torneioMode) return;
    const el = playersSectionRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [torneioMode, actionLogRowCount, actionLogLastKey]);

  // Reconstrói o pote em cada frame da animação. `spot.pot` representa o pote completo no
  // momento da decisão; retiramos os compromissos finais da street e recolocamos apenas os
  // valores que já apareceram na linha do tempo. Isso também evita dupla contagem quando um
  // jogador primeiro limpa e depois completa uma 3-bet, pois cada card guarda o total acumulado.
  const finalStreetCommittedChips = spot.seats.reduce((sum, seat) => sum + Number(seat.betChips || 0), 0);
  const potBeforeAnimatedActions = Math.max(0, Number(spot.pot || 0) - finalStreetCommittedChips);
  const animatedCommittedChips = animatedSeats.reduce((sum, seat) => sum + Number(seat.displayBetChips || 0), 0);
  const animatedPotChips = potBeforeAnimatedActions + animatedCommittedChips;
  const animatedPotBB = animatedPotChips / spot.bb;
  const animatedPotBreakdown = spot.hasMultiShove
    ? calculateSidePots(animatedSeats, potBeforeAnimatedActions)
    : { pots: [], refunds: [] };
  const effectiveMatchups = visibleSeats
    .filter((seat) => !seat.isHero && seat.isInvolved)
    .map((seat) => ({ pos: seat.pos, bb: Math.min(Number(spot.heroStackBB || 0), Number(seat.stackBB || spot.heroStackBB || 0)) }));

  // Agrupa o histórico real (todo o histórico, não só a sessão atual) por fase e por preset —
  // usado nos cards de FASE e nos botões de TREINO ESPECÍFICO pra mostrar o progresso cumulativo
  // de cada um, independente da sessão de contagem do HU/TOTAL (que reinicia a cada escolha).
  const historyByFase = {}, historyByPreset = {}, historyByPosition = {};
  for (const h of history) {
    if (h.presetKey) historyByPreset[h.presetKey] = (historyByPreset[h.presetKey] || 0) + 1;
    else historyByFase[h.fase] = (historyByFase[h.fase] || 0) + 1;
    if (!h.presetKey && h.position) historyByPosition[h.position] = (historyByPosition[h.position] || 0) + 1;
  }

  // DESEMPENHO PARCIAL: histórico acumulado do "treino atual" (a mesma combinação de fase +
  // street + posição — ou preset — que já filtra os spots de verdade, ver INFORMAÇÕES DO
  // TREINO abaixo). Reaproveita infoTreinoEntries, definido logo depois: quando fase (ou
  // street/posição) está em ALEATÓRIO, esse filtro corretamente NÃO restringe por aquela
  // dimensão — o bug antigo comparava h.fase === "ALEATORIO" literalmente, que nunca bate
  // (cada spot grava a fase específica sorteada, nunca a palavra ALEATORIO), zerando esta
  // seção sempre que o usuário estava no modo padrão (aleatório).
  const infoTreinoEntries = activePreset
    ? history.filter((h) => h.presetKey === activePresetKey)
    : history.filter((h) =>
        !h.presetKey &&
        ((!fase || fase === "ALEATORIO") || h.fase === fase) &&
        ((!street || street === "MIXED") || h.street === street) &&
        ((!heroPositionFilter || heroPositionFilter === "ALEATORIO") || h.position === heroPositionFilter) &&
        ((!stackFilter || stackFilter === "ALEATORIO") || h.stackFilter === stackFilter)
      );
  const selectedEntries = infoTreinoEntries;
  const partialRealized = selectedEntries.length;
  const partialCorrect = selectedEntries.filter((h) => h.correct).length;
  const partialAccuracyPct = partialRealized > 0 ? ((partialCorrect / partialRealized) * 100).toFixed(1) : "0.0";
  const partialSpots = spotsPerFase;
  const partialCompletionPct = Math.min(100, (partialRealized / partialSpots) * 100).toFixed(1);

  const infoTreinoRealizados = infoTreinoEntries.length;

  // DESEMPENHO TOTAL: soma de TODOS os treinos que o usuário já realizou de verdade (não um
  // teto teórico de 9 fases + presets) — cada "treino" distinto (uma fase específica, ou um
  // preset específico) que aparece no histórico conta como um treino realizado, com meta de
  // spotsPerFase cada. Esse total zera ou persiste entre reinícios do app de acordo com a
  // escolha do usuário em APAGAR DADOS / MANTER DADOS (ver keepDataOnRestart).
  const totalCorrect = history.filter((h) => h.correct).length;
  const totalRealized = history.length;
  const distinctTrainingKeys = new Set(history.map((h) => h.presetKey || h.fase));
  const totalSpots = Math.max(spotsPerFase, distinctTrainingKeys.size * spotsPerFase);
  // ACERTOS (linha 4, %): acertos totais sobre o TOTAL DE SPOTS DISPONÍVEIS PRA TREINO
  // (totalSpots — o mesmo valor mostrado na linha 3 da coluna SPOTS ao lado), não sobre
  // totalRealized — pedido explícito do usuário pra refletir o aproveitamento real contra
  // todo o banco de spots, não só contra o que já foi jogado.
  const totalAccuracyPct = totalSpots > 0 ? ((totalCorrect / totalSpots) * 100).toFixed(1) : "0.0";
  const totalCompletionPct = Math.min(100, (totalRealized / totalSpots) * 100).toFixed(1);

  // LEAK FINDER — 4 etapas reais sobre o histórico de mãos treinadas NO APP (não sala online):
  // 1. Coleta: history já é essa base, sem coletar nada de novo.
  // 2. Varredura: agrupa por posição/street/fase/cenário, soma acerto e EV perdido por grupo.
  // 3. Comparação: grupo precisa de amostra mínima (senão é ruído, não padrão real).
  // 4. Correção: ordena pelo maior EV perdido médio — aponta o ajuste mais valioso a estudar.
  const MIN_LEAK_SAMPLE = 5;
  const computeLeakGroups = (dimension, labelFn) => {
    const groups = new Map();
    for (const h of history) {
      const key = h[dimension];
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { n: 0, correct: 0, evLossTotal: 0 });
      const g = groups.get(key);
      g.n++;
      if (h.correct) g.correct++;
      g.evLossTotal += Number(h.evLossBB || 0);
    }
    return [...groups.entries()]
      .filter(([, g]) => g.n >= MIN_LEAK_SAMPLE)
      .map(([key, g]) => ({ label: labelFn(key), n: g.n, accPct: (g.correct / g.n) * 100, evLossAvg: g.evLossTotal / g.n }));
  };
  const topLeaks = [
    ...computeLeakGroups("position", (k) => `POSIÇÃO ${k}`),
    ...computeLeakGroups("street", (k) => `STREET ${k}`),
    ...computeLeakGroups("fase", (k) => `FASE ${faseDisplayLabel(k)}`),
    ...computeLeakGroups("scenario", (k) => `CENÁRIO ${k}`),
  ].sort((a, b) => b.evLossAvg - a.evLossAvg).slice(0, 3);

  // Relatório de sessão do LEAK MODE: mesma varredura, mas só nas mãos DESTA sessão (desde a
  // última troca de filtro/preset — huSessionStart), exibido quando a meta de spots é batida.
  const sessionEntries = history.slice(huSessionStart);
  const sessionCorrect = sessionEntries.filter((h) => h.correct).length;
  const sessionAccPct = sessionEntries.length > 0 ? (sessionCorrect / sessionEntries.length) * 100 : 0;
  const computeSessionLeakGroups = (dimension, labelFn) => {
    const groups = new Map();
    for (const h of sessionEntries) {
      const key = h[dimension];
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { n: 0, correct: 0, evLossTotal: 0 });
      const g = groups.get(key);
      g.n++;
      if (h.correct) g.correct++;
      g.evLossTotal += Number(h.evLossBB || 0);
    }
    return [...groups.entries()]
      .filter(([, g]) => g.n >= Math.min(MIN_LEAK_SAMPLE, sessionEntries.length))
      .map(([key, g]) => ({ label: labelFn(key), n: g.n, accPct: (g.correct / g.n) * 100, evLossAvg: g.evLossTotal / g.n }));
  };
  const sessionTopLeaks = [
    ...computeSessionLeakGroups("position", (k) => `POSIÇÃO ${k}`),
    ...computeSessionLeakGroups("street", (k) => `STREET ${k}`),
    ...computeSessionLeakGroups("scenario", (k) => `CENÁRIO ${k}`),
  ].sort((a, b) => b.evLossAvg - a.evLossAvg).slice(0, 3);

  // Card SPOTS: soma o alvo (spotsPerFase) de cada FILTRO combinado ativo agora (fase, street e
  // posição contam como treinos "relacionados" quando mais de um está ligado ao mesmo tempo —
  // ex: treino por fase + treino por street juntos = 2x spotsPerFase somados), contra o alvo
  // somado de TODOS os treinos distintos já realizados historicamente (mesma contagem de
  // distinctTrainingKeys usada acima em DESEMPENHO TOTAL).
  const activeFilterDimensions = activePreset
    ? 1
    : [!!fase && fase !== "ALEATORIO", !!street && street !== "MIXED", !!heroPositionFilter && heroPositionFilter !== "ALEATORIO", !!stackFilter && stackFilter !== "ALEATORIO"].filter(Boolean).length || 1;
  const spotsCurrentTarget = spotsPerFase * activeFilterDimensions;
  const spotsCurrentPct = Math.min(100, (infoTreinoRealizados / spotsCurrentTarget) * 100).toFixed(1);
  const spotsTotalAvailable = totalSpots;
  // Card DESEMPENHO, coluna SPOTS (linha 2, %): alvo do filtro atual (spotsCurrentTarget, linha 1)
  // sobre o TOTAL de spots disponíveis pra treino (spotsTotalAvailable, linha 3) — não sobre
  // infoTreinoRealizados, que é o que spotsCurrentPct usa pro card INFORMAÇÕES DO TREINO (mantido
  // como está). Como a linha 3 já É spotsTotalAvailable, a linha 4 (%) é trivialmente 100% —
  // não precisa de variável, é escrita direto no JSX.
  const desempenhoSpotsMetaPct = spotsTotalAvailable > 0 ? Math.min(100, (spotsCurrentTarget / spotsTotalAvailable) * 100).toFixed(1) : "0.0";

  if (openingScreen) return <StackupOpeningScreen onLogin={() => setOpeningScreen(false)} onRegister={() => setOpeningScreen(false)} />;\n\n  return (
    <div style={{ background: "#000", minHeight: "100vh", padding: 12, fontFamily: "'JetBrains Mono', monospace", color: "#FFF", textTransform: "uppercase" }}>
      <style>{`
        @keyframes nlhBlinkBorder { 0%,100% { box-shadow: 0 0 8px currentColor; } 50% { box-shadow: 0 0 20px currentColor, 0 0 32px currentColor; } }
        @keyframes nlhBlinkText { 0%,100% { opacity: 1; text-shadow: 0 0 8px currentColor; } 50% { opacity: 0.55; text-shadow: 0 0 20px currentColor, 0 0 30px currentColor; } }
        @keyframes nlhStartPulse { 0%,100% { opacity: 1; box-shadow: 0 0 12px rgba(239,68,68,.75), 0 0 24px rgba(239,68,68,.35); text-shadow: 0 0 8px rgba(255,255,255,.85); } 50% { opacity: .48; box-shadow: 0 0 24px rgba(239,68,68,1), 0 0 40px rgba(239,68,68,.65); text-shadow: 0 0 18px #fff; } }
        @keyframes nlhActionFlash { 0%,40%,80% { opacity: .25; transform: scale(.99); } 20%,60%,100% { opacity: 1; transform: scale(1.01); } }
        @keyframes nlhHeroDecisionPulse { 0%,100% { box-shadow: 0 0 10px currentColor, 0 0 20px currentColor; } 50% { box-shadow: 0 0 22px currentColor, 0 0 40px currentColor, inset 0 0 10px currentColor; } }
        @keyframes nlhLogRowIn { 0% { opacity: 0; transform: translateY(-4px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes nlhLogRowWalkOut { 0% { opacity: 1; transform: translateX(0); } 100% { opacity: 0; transform: translateX(130%); } }
        .nlh-blink-border { animation: nlhBlinkBorder 1s infinite; }
        .nlh-blink-text { animation: nlhBlinkText 1s infinite; }
        .nlh-start-pulse { animation: nlhStartPulse .85s ease-in-out infinite; }
        .nlh-action-flash { animation: nlhActionFlash .62s ease-in-out; }
        .nlh-hero-decision-pulse { animation: nlhHeroDecisionPulse .85s ease-in-out infinite; }
        .nlh-log-row { animation: nlhLogRowIn .18s ease-out; }
        /* Fold: a linha aparece completa (nlhLogRowIn normal), fica 1s parada e só então "anda"
           pra fora do card inteira de uma vez, deslizando da esquerda pra direita até sumir pela
           borda direita (FOLD_WALK_OUT_MS no timer da sequência precisa bater com essa duração). */
        .nlh-log-row-fold { animation: nlhLogRowIn .18s ease-out, nlhLogRowWalkOut .4s ease-in 1s both; }
        .nlh-action-log-scroll { scrollbar-width: thin; scrollbar-color: #475569 rgba(15,23,42,0.4); }
        .nlh-action-log-scroll::-webkit-scrollbar { width: 6px; }
        .nlh-action-log-scroll::-webkit-scrollbar-track { background: rgba(15,23,42,0.4); border-radius: 3px; }
        .nlh-action-log-scroll::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; }
      `}</style>
      <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8, fontSize: 15 }}>

        <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center", color: "#22D3EE", border: "1.5px solid #22D3EE", boxShadow: "0 0 16px rgba(34,211,238,0.65), 0 0 32px rgba(6,182,212,0.35)", textShadow: "0 1px 2px rgba(0,0,0,0.9), 0 0 10px rgba(34,211,238,0.65)", borderRadius: 8, fontWeight: 900, fontSize: 14, letterSpacing: "0.35em" }}>
          STACKUP HOLD&apos;EM
        </div>

        <ConfigPanel
          open={aiPanelOpen}
          onToggle={() => setAiPanelOpen((v) => !v)}
          title="INTEGRAR IA"
          summary={aiProvider ? AI_PROVIDERS.find((p) => p.key === aiProvider)?.label : "SEM INTEGRAÇÃO"}
          color="#A855F7"
        >
              <div style={{ fontSize: 11, color: "#D8B4FE", lineHeight: 1.5, textAlign: "left" }}>
                Use sua própria chave de API. Ela fica salva só neste app, não é compartilhada com ninguém. Escolha o provedor, cole a foto da estrutura do torneio e a IA sugere modalidade/field/mesa automaticamente.
              </div>

              <SelCard active={aiProvider === null} style={{ height: 30, width: "100%" }} onClick={() => handleToggleClick(aiProvider, null, null, setAiProvider)}>SEM INTEGRAÇÃO</SelCard>
              <div className="grid grid-cols-3" style={{ gap: 8 }}>
                {AI_PROVIDERS.map((p) => (
                  <SelCard key={p.key} active={aiProvider === p.key} style={{ height: 30 }} onClick={() => handleToggleClick(aiProvider, null, p.key, (v) => { setAiProvider(v); if (v) setAiKeyInput(aiKeys[v] || ""); })}>{p.label}</SelCard>
                ))}
              </div>

              {aiProvider === null ? (
                <div style={{ fontSize: 11, color: "#9CA3AF", lineHeight: 1.5 }}>Escolha um provedor acima pra configurar a chave e usar a análise por IA.</div>
              ) : (
                <>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder={`CHAVE DE API — ${aiProvider.toUpperCase()}`}
                  value={aiKeyInput}
                  onChange={(e) => setAiKeyInput(e.target.value)}
                  style={{ flex: 1, height: 40, background: "#000", border: "1.5px solid #A855F7", borderRadius: 6, color: "#FFF", fontSize: 11, padding: "0 8px" }}
                />
                <button onClick={() => saveAiKey(aiProvider, aiKeyInput)} className="rounded-md" style={{ height: 40, padding: "0 12px", border: "1.5px solid #A855F7", color: "#D8B4FE", background: "#000", fontWeight: 900, fontSize: 11 }}>
                  SALVAR
              </button>
            </div>
            {aiKeys[aiProvider] && <div style={{ fontSize: 11, color: "#86EFAC" }}>CHAVE SALVA PARA {aiProvider.toUpperCase()} ✓</div>}

            {aiKeys[aiProvider] && (
              <div className="rounded-md" style={{ border: "1px solid #A855F7", padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <SelCard active={aiSpotGenerationEnabled} style={{ height: 32, width: "100%" }} onClick={() => setAiSpotGenerationEnabled((v) => !v)}>
                  GERAÇÃO DE SPOTS POR IA (BETA) {aiSpotGenerationEnabled ? "— ATIVA" : ""}
                </SelCard>
                <div style={{ fontSize: 10, color: "#9CA3AF", lineHeight: 1.4 }}>
                  A IA só escolhe posição/cenário/mão/profundidade dentro do que o app já suporta — a ação correta continua sempre calculada pelo motor do app, nunca pela IA. Só funciona com FASE e STREET escolhidas (não ALEATÓRIO/MIXED). Se a IA falhar ou demorar, o spot local aparece normalmente.
                  {aiSpotFetching && <span style={{ color: "#D8B4FE" }}> Buscando próximo spot com IA...</span>}
                </div>
              </div>
            )}

            <label className="rounded-md flex items-center justify-center cursor-pointer" style={{ height: 44, border: "1px dashed #A855F7", color: "#D8B4FE", fontSize: 11, fontWeight: 800 }}>
              {aiPhoto ? "FOTO CARREGADA ✓ — TROCAR" : "SELECIONAR FOTO DA ESTRUTURA"}
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handlePhotoSelect(e.target.files[0])} />
            </label>

            <button onClick={runAiAnalysis} disabled={aiLoading} className="rounded-md" style={{ height: 44, border: "1.5px solid #A855F7", color: "#FFF", background: aiLoading ? "#4B5563" : "rgba(168,85,247,0.25)", fontWeight: 900, fontSize: 11 }}>
              {aiLoading ? "ANALISANDO..." : "ANALISAR ESTRUTURA E CONFIGURAR"}
            </button>

            {aiError && <div style={{ fontSize: 11, color: "#FCA5A5", lineHeight: 1.5 }}>{aiError}</div>}
            {aiResult && <div style={{ fontSize: 11, color: "#86EFAC", lineHeight: 1.5 }}>{aiResult}</div>}
                </>
              )}
        </ConfigPanel>

        <button onClick={() => setShowConfigCards((v) => !v)} className="rounded-md" style={{ height: 38, border: "1.5px solid #FACC15", background: showConfigCards ? "#FACC1518" : "transparent", color: "#FACC15", fontWeight: 900, fontSize: 11, letterSpacing: "0.1em" }}>
          CONFIGURAÇÕES {showConfigCards ? "▲" : "▼"}
        </button>

        {showConfigCards && (
          <>
        <ConfigPanel open={openConfigPanel === "torneio"} onToggle={() => setOpenConfigPanel((value) => value === "torneio" ? null : "torneio")} title="TIPO DE TORNEIO" summary={MODALIDADES.find((item) => item.key === modalidade)?.label || modalidade}>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {MODALIDADES.slice(0, 3).map((m) => {
              const active = modalidade === m.key;
              return <SelCard key={m.key} active={active} style={{ height: 30 }} onClick={() => handleToggleClick(modalidade, "regular", m.key, setModalidade)}>{m.label}</SelCard>;
            })}
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {MODALIDADES.slice(3, 6).map((m) => {
              const active = modalidade === m.key;
              return <SelCard key={m.key} active={active} style={{ height: 30 }} onClick={() => handleToggleClick(modalidade, "regular", m.key, setModalidade)}>{m.label}</SelCard>;
            })}
          </div>
        </ConfigPanel>

        <ConfigPanel open={openConfigPanel === "field"} onToggle={() => setOpenConfigPanel((value) => value === "field" ? null : "field")} title="INFORMAÇÕES DO FIELD" summary={<><span style={{ display: "block" }}>{field} PLAYERS · MESA {String(tableSize).padStart(2, "0")} PL</span><span style={{ display: "block", marginTop: 3 }}>{MIXES.find((item) => item.key === mix)?.label || mix}</span></>} minHeight={45}>
          <div className="grid grid-cols-5 gap-2">
            {FIELDS.map((f) => {
              const active = field === f;
              return (
                <SelCard key={f} active={active} onClick={() => handleToggleClick(field, 100, f, setField)}>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
                    <div style={{ fontSize: 11, color: "#9CA3AF" }}>PLAYERS</div><div style={{ fontSize: 11 }}>{f}</div>
                  </div>
                </SelCard>
              );
            })}
          </div>

          <div className="flex flex-col gap-2">
            {MIXES.map((m) => {
              const active = mix === m.key;
              return <SelCard key={m.key} active={active} style={{ height: 36 }} onClick={() => handleToggleClick(mix, "50", m.key, setMix)}>{m.label}</SelCard>;
            })}
          </div>

          <div className="grid grid-cols-4 gap-2">
            {TABLES.map((t) => {
              const active = tableSize === t;
              return (
                <SelCard key={t} active={active} onClick={() => handleToggleClick(tableSize, 9, t, setTableSize)}>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
                    <div style={{ fontSize: 11, color: "#9CA3AF" }}>MESA</div><div style={{ fontSize: 11 }}>{String(t).padStart(2,"0")} PL</div>
                  </div>
                </SelCard>
              );
            })}
          </div>
        </ConfigPanel>

        <ConfigPanel open={openConfigPanel === "amostragem"} onToggle={() => setOpenConfigPanel((value) => value === "amostragem" ? null : "amostragem")} title="AMOSTRAGEM DE TREINO" summary={`${spotsPerFase} SPOTS`}>
          <div className="grid grid-cols-5" style={{ gap: 8 }}>
            {SPOTS_OPTIONS.map((n) => {
              const active = spotsPerFase === n;
              return (
                <SelCard key={n} active={active} style={{ height: 35 }} onClick={() => handleToggleClick(spotsPerFase, 500, n, (v) => {
                  setSpotsPerFase(v);
                  setSpotIndex(1);
                  // Trocar a meta começa uma sessão nova de contagem pro contexto atual —
                  // senão o progresso antigo fica "travado" mostrando um número que não bate
                  // mais com o spot #1 que acabamos de voltar a mostrar.
                  if (activePreset) setPresetProgress((p) => ({ ...p, [activePreset.key]: 0 }));
                  else setFaseProgress((p) => ({ ...p, [fase]: 0 }));
                  setSessionCompleteNotice(false);
                  setDecision(null);
                })}>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
                    <div style={{ fontSize: 11 }}>{n}</div><div style={{ fontSize: 11, color: "#9CA3AF" }}>SPOTS</div>
                  </div>
                </SelCard>
              );
            })}
          </div>
        </ConfigPanel>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, opacity: activePreset ? 0.35 : 1, pointerEvents: activePreset ? "none" : "auto" }}>
        <ConfigPanel open={openConfigPanel === "street"} onToggle={() => setOpenConfigPanel((value) => value === "street" ? null : "street")} title="TREINO POR STREET" summary={!street ? "INATIVO" : [...STREETS_ROW1, ...STREETS_ROW2].find((item) => item.key === street)?.label || street}>
          <div className="grid grid-cols-2" style={{ gap: 8 }}>
            {STREETS_ROW1.map((s) => {
              const active = street === s.key;
              return <SelCard key={s.key} active={active} style={{ height: 35 }} onClick={() => handleFilterToggleClick(street, "MIXED", s.key, (v) => { setStreet(v); setSpotIndex(1); resetHuSession(); })}>{s.label}</SelCard>;
            })}
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {STREETS_ROW2.map((s) => {
              const active = street === s.key;
              return <SelCard key={s.key} active={active} style={{ height: 35 }} onClick={() => handleFilterToggleClick(street, "MIXED", s.key, (v) => { setStreet(v); setSpotIndex(1); resetHuSession(); })}>{s.label}</SelCard>;
            })}
          </div>
        </ConfigPanel>

        <ConfigPanel open={openConfigPanel === "posicao"} onToggle={() => setOpenConfigPanel((value) => value === "posicao" ? null : "posicao")} title="TREINO POR POSIÇÃO" summary={!heroPositionFilter ? "INATIVO" : heroPositionFilter === "ALEATORIO" ? "ALEATÓRIO" : heroPositionFilter}>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {HERO_POSITION_FILTER_OPTIONS.map((posKey) => {
              const active = heroPositionFilter === posKey;
              const label = posKey === "ALEATORIO" ? "ALEATÓRIO" : posKey;
              return (
                <div key={posKey} onClick={() => handleFilterToggleClick(heroPositionFilter, "ALEATORIO", posKey, (v) => { setHeroPositionFilter(v); setSpotIndex(1); resetHuSession(); })} className="rounded-md flex items-center justify-center cursor-pointer" style={{ height: 30, border: active ? "1.5px solid #FACC15" : "1.5px solid #333" }}>
                  <div style={{ fontSize: 11, color: "#FACC15", fontWeight: 900, lineHeight: 1.1 }}>{label}</div>
                </div>
              );
            })}
          </div>
        </ConfigPanel>

        <ConfigPanel open={openConfigPanel === "fase"} onToggle={() => setOpenConfigPanel((value) => value === "fase" ? null : "fase")} title="TREINO POR FASE" summary={!fase ? "INATIVO" : faseDisplayLabel(fase)}>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            <div onClick={() => handleFilterToggleClick(fase, "ALEATORIO", "ALEATORIO", (v) => { setFase(v); setSpotIndex(1); resetHuSession(); })} className="rounded-md flex items-center justify-center cursor-pointer" style={{ height: 38, border: fase === "ALEATORIO" ? "1.5px solid #FACC15" : "1.5px solid #333" }}>
              <div style={{ fontSize: 11, color: "#FACC15", fontWeight: 900, lineHeight: 1.1 }}>ALEATÓRIO</div>
            </div>
            {FASES.map((f) => {
              const active = fase === f.key;
              return (
                <div key={f.key} onClick={() => handleFilterToggleClick(fase, "ALEATORIO", f.key, (v) => { setFase(v); setSpotIndex(1); resetHuSession(); })} className="rounded-md flex items-center justify-center cursor-pointer" style={{ height: 38, border: active ? "1.5px solid #FACC15" : "1.5px solid #333" }}>
                  <div style={{ fontSize: 11, color: "#FACC15", fontWeight: 900, lineHeight: 1.1 }}>{faseDisplayLabel(f.key)}</div>
                </div>
              );
            })}
          </div>
        </ConfigPanel>

        {/* TREINO POR STACK — participa da mesma combinação cumulativa de FASE/STREET/POSIÇÃO
            (mesmo wrapper de opacidade, desativado junto quando um TREINO ESPECÍFICO está
            ativo). O botão ALEATÓRIO ocupa a linha inteira, acima da grade 3x3 de profundidades. */}
        <ConfigPanel open={openConfigPanel === "stack"} onToggle={() => setOpenConfigPanel((value) => value === "stack" ? null : "stack")} title="TREINO POR STACK" summary={!stackFilter ? "INATIVO" : stackFilter === "ALEATORIO" ? "ALEATÓRIO" : `${stackFilter} BB`}>
          <div onClick={() => handleFilterToggleClick(stackFilter, "ALEATORIO", "ALEATORIO", (v) => { setStackFilter(v); setSpotIndex(1); resetHuSession(); })} className="rounded-md flex items-center justify-center cursor-pointer" style={{ height: 38, border: stackFilter === "ALEATORIO" ? "1.5px solid #FACC15" : "1.5px solid #333" }}>
            <div style={{ fontSize: 11, color: "#FACC15", fontWeight: 900, lineHeight: 1.1 }}>ALEATÓRIO</div>
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {STACK_OPTIONS.map((bb) => {
              const active = stackFilter === bb;
              return (
                <div key={bb} onClick={() => handleFilterToggleClick(stackFilter, "ALEATORIO", bb, (v) => { setStackFilter(v); setSpotIndex(1); resetHuSession(); })} className="rounded-md flex items-center justify-center cursor-pointer" style={{ height: 38, border: active ? "1.5px solid #FACC15" : "1.5px solid #333" }}>
                  <div style={{ fontSize: 11, color: "#FACC15", fontWeight: 900, lineHeight: 1.1 }}>{bb} BB</div>
                </div>
              );
            })}
          </div>
        </ConfigPanel>
        </div>

        <ConfigPanel open={openConfigPanel === "especifico"} onToggle={() => setOpenConfigPanel((value) => value === "especifico" ? null : "especifico")} title="TREINO ESPECÍFICO" summary={activePreset?.label || "INATIVO"}>
          <div style={{ display: "none" }} aria-hidden="true">
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {TRAINING_PRESETS.filter((p) => p.group === "DEFESA DE BB").map((p) => {
              const pp = Math.min(historyByPreset[p.key] || 0, spotsPerFase); // dado real do histórico
              const pct = ((pp / spotsPerFase) * 100).toFixed(0);
              return (
                <div key={p.key} onClick={() => handlePresetLockedClick(p)} className="rounded-md flex flex-col items-center justify-center cursor-pointer" style={{ height: 56, border: activePresetKey === p.key ? "1.5px solid #A855F7" : "1.5px solid #333", opacity: activePresetKey !== p.key ? 0.35 : 1 }}>
                  <div style={{ fontSize: 11, color: "#D8B4FE", fontWeight: 900 }}>{p.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>{String(pp).padStart(3,"0")}/{spotsPerFase}</div>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>SPOTS - {pct}%</div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {TRAINING_PRESETS.filter((p) => ["BLIND_WAR", "ATK_BLINDS_CO_BTN", "REACAO_3BET"].includes(p.key)).map((p) => {
              const pp = Math.min(historyByPreset[p.key] || 0, spotsPerFase); // dado real do histórico
              const pct = ((pp / spotsPerFase) * 100).toFixed(0);
              return (
                <div key={p.key} onClick={() => handlePresetLockedClick(p)} className="rounded-md flex flex-col items-center justify-center cursor-pointer" style={{ height: 56, border: activePresetKey === p.key ? "1.5px solid #A855F7" : "1.5px solid #333", opacity: activePresetKey !== p.key ? 0.35 : 1 }}>
                  <div style={{ fontSize: 11, color: "#D8B4FE", fontWeight: 900 }}>{p.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>{String(pp).padStart(3,"0")}/{spotsPerFase}</div>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>SPOTS - {pct}%</div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {TRAINING_PRESETS.filter((p) => ["FLAT_POSICAO", "CO_BTN_PLAY", "CHIP_UP"].includes(p.key)).map((p) => {
              const pp = Math.min(historyByPreset[p.key] || 0, spotsPerFase); // dado real do histórico
              const pct = ((pp / spotsPerFase) * 100).toFixed(0);
              return (
                <div key={p.key} onClick={() => handlePresetLockedClick(p)} className="rounded-md flex flex-col items-center justify-center cursor-pointer" style={{ height: 56, border: activePresetKey === p.key ? "1.5px solid #A855F7" : "1.5px solid #333", opacity: activePresetKey !== p.key ? 0.35 : 1 }}>
                  <div style={{ fontSize: 11, color: "#D8B4FE", fontWeight: 900 }}>{p.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>{String(pp).padStart(3,"0")}/{spotsPerFase}</div>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>SPOTS - {pct}%</div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {TRAINING_PRESETS.filter((p) => p.group === "ALL-IN E STACK CURTO").map((p) => {
              const pp = Math.min(historyByPreset[p.key] || 0, spotsPerFase);
              const pct = ((pp / spotsPerFase) * 100).toFixed(0);
              return (
                <div key={p.key} onClick={() => handlePresetLockedClick(p)} className="rounded-md flex flex-col items-center justify-center cursor-pointer" style={{ height: 56, border: activePresetKey === p.key ? "1.5px solid #A855F7" : "1.5px solid #333", opacity: activePresetKey !== p.key ? 0.35 : 1 }}>
                  <div style={{ fontSize: 11, color: "#D8B4FE", fontWeight: 900 }}>{p.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>{String(pp).padStart(3,"0")}/{spotsPerFase}</div>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>SPOTS - {pct}%</div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            {TRAINING_PRESETS.filter((p) => p.group === "MULTIWAY E LIMPERS").map((p) => {
              const pp = Math.min(historyByPreset[p.key] || 0, spotsPerFase);
              const pct = ((pp / spotsPerFase) * 100).toFixed(0);
              return (
                <div key={p.key} onClick={() => handlePresetLockedClick(p)} className="rounded-md flex flex-col items-center justify-center cursor-pointer" style={{ height: 56, border: activePresetKey === p.key ? "1.5px solid #A855F7" : "1.5px solid #333", opacity: activePresetKey !== p.key ? 0.35 : 1 }}>
                  <div style={{ fontSize: 11, color: "#D8B4FE", fontWeight: 900 }}>{p.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>{String(pp).padStart(3,"0")}/{spotsPerFase}</div>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>SPOTS - {pct}%</div>
                </div>
              );
            })}
          </div>
          </div>
          <div className="grid grid-cols-3" style={{ gap: 8 }}>
            <div
              onClick={() => handlePresetLockedClick({ key: null })}
              className="rounded-md flex items-center justify-center cursor-pointer"
              style={{
                height: 38,
                padding: "2px 4px",
                border: `1.5px solid ${TRAINING_ESPECIFICO_COLOR}`,
                opacity: activePresetKey !== null ? 0.35 : 1,
              }}
            >
              <div style={{ fontSize: 10, color: "#FACC15", fontWeight: 900, lineHeight: 1.15, textAlign: "center", overflowWrap: "break-word" }}>INATIVO</div>
            </div>
            {ORDERED_TRAINING_PRESETS.map((preset) => {
              const selected = activePresetKey === preset.key;
              return (
                <div
                  key={preset.key}
                  onClick={() => handlePresetLockedClick(preset)}
                  className="rounded-md flex items-center justify-center cursor-pointer"
                  style={{
                    height: 38,
                    padding: "2px 4px",
                    border: `1.5px solid ${TRAINING_ESPECIFICO_COLOR}`,
                    opacity: !selected ? 0.35 : 1,
                  }}
                >
                  <div style={{ fontSize: 10, color: "#FACC15", fontWeight: 900, lineHeight: 1.15, textAlign: "center", overflowWrap: "break-word" }}>{preset.label}</div>
                </div>
              );
            })}
          </div>
        </ConfigPanel>
          </>
        )}

        {sessionCompleteNotice && (
          <div className="rounded-md flex flex-col items-center justify-center text-center gap-2" style={{ border: "1.5px solid #A855F7", boxShadow: "0 0 14px rgba(168,85,247,0.4)", padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#D8B4FE", letterSpacing: "0.1em" }}>SESSÃO CONCLUÍDA</div>
            <div style={{ fontSize: 11, color: "#E9D5FF" }}>Bateu a meta de spots{activePreset ? ` de ${activePreset.label}` : ""}. Vale a pena ver onde os leaks estão antes de seguir treinando.</div>
            <button onClick={() => { setHistoryPanelOpen(true); runAiReport(); }} className="rounded-md" style={{ height: 34, width: "100%", border: "1.5px solid #A855F7", color: "#FFF", background: "rgba(168,85,247,0.3)", fontWeight: 900, fontSize: 11 }}>
              VER LEAKS E TREINO RECOMENDADO
            </button>
          </div>
        )}

        {/* INFORMAÇÕES DO TREINO — resumo do que está selecionado agora (fase/street/posição
            combinados, ou o treino específico ativo, que sempre tem prioridade sobre os
            outros três) e quantos spots já foram feitos dentro dessa combinação exata. */}
        <div className="rounded-md" style={{ width: "100%", border: "1.5px solid #FACC15", padding: "8px 10px", textAlign: "center" }}>
          <div style={{ color: "#FACC15", fontSize: 11, fontWeight: 900, letterSpacing: "0.1em" }}>INFORMAÇÕES DO TREINO</div>
          <div style={{ color: "#FFF", fontSize: 11, fontWeight: 800, marginTop: 4 }}>
            {activePreset
              ? `TREINO ESPECÍFICO: ${activePreset.label}`
              : [
                  fase && fase !== "ALEATORIO" ? `FASE: ${faseDisplayLabel(fase)}` : null,
                  street && street !== "MIXED" ? `STREET: ${[...STREETS_ROW1, ...STREETS_ROW2].find((s) => s.key === street)?.label || street}` : null,
                  heroPositionFilter && heroPositionFilter !== "ALEATORIO" ? `POSIÇÃO: ${heroPositionFilter}` : null,
                  stackFilter && stackFilter !== "ALEATORIO" ? `STACK: ${stackFilter} BB` : null,
                ].filter(Boolean).join(" · ") || "ALEATÓRIO (SEM FILTRO)"}
          </div>
          <div style={{ color: "#9CA3AF", fontSize: 11, marginTop: 3 }}>
            {String(infoTreinoRealizados).padStart(5, "0")} / {String(spotsPerFase).padStart(5, "0")} / {String(spotsCurrentTarget).padStart(5, "0")}
          </div>
          <div style={{ color: "#9CA3AF", fontSize: 11, fontWeight: 900, marginTop: 2 }}>
            {spotsCurrentPct.replace(".", ",")}% REALIZADO
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button onClick={actionFlowEnabled ? endActionSequence : beginActionSequence} disabled={actionStep >= 0 && !sequenceReady} className={`rounded-md ${!actionFlowEnabled ? "nlh-start-pulse" : ""}`} style={{ height: 38, border: "1.5px solid #EF4444", color: "#EF4444", background: !actionFlowEnabled ? "rgba(239,68,68,0.22)" : "rgba(239,68,68,0.14)", boxShadow: !actionFlowEnabled ? "0 0 14px rgba(239,68,68,0.75), 0 0 26px rgba(239,68,68,0.35)" : "0 0 10px rgba(239,68,68,0.35)", fontWeight: 900, fontSize: 11, opacity: actionStep >= 0 && !sequenceReady ? 0.55 : 1 }}>
            {actionStep >= 0 && !sequenceReady ? actionPaused ? "AÇÕES PAUSADAS" : "AÇÕES EM ANDAMENTO..." : actionFlowEnabled ? "FINALIZAR" : "INICIAR"}
          </button>
          <button onClick={repeatSpots} disabled={actionStep >= 0 && !sequenceReady} className="rounded-md" style={{ height: 38, border: "1.5px solid #EF4444", color: "#EF4444", background: "transparent", boxShadow: "0 0 10px rgba(239,68,68,0.35)", fontWeight: 900, fontSize: 11, opacity: actionStep >= 0 && !sequenceReady ? 0.55 : 1 }}>
            REPETIR SPOTS
          </button>
          <button onClick={() => setSoundEnabled((v) => !v)} className="rounded-md" style={{ height: 38, border: "1.5px solid #EF4444", color: "#EF4444", background: soundEnabled ? "rgba(239,68,68,0.14)" : "transparent", boxShadow: "0 0 10px rgba(239,68,68,0.35)", fontWeight: 900, fontSize: 11 }}>
            {soundEnabled ? "🔊 SOM" : "🔇 SOM"}
          </button>
        </div>

        <div className="rounded-md flex flex-col items-center justify-center text-center" style={{ height: 75, border: "1.5px solid #3B82F6", boxShadow: "0 0 12px rgba(59,130,246,0.35)", padding: 8 }}>
          {actionFlowEnabled ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#3B82F6" }}>NÍVEL {String(spot.nivel).padStart(2,"0")}</div>
              <div style={{ fontSize: 11 }}>SB {fmtChips(spot.sb)} • {(spot.sb/spot.bb).toFixed(1)} BB / BB {fmtChips(spot.bb)} • 1 BB</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>BB ANTE {fmtChips(spot.ante || spot.bb)} • 1 BB</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#3B82F6" }}>NÍVEL 00</div>
              <div style={{ fontSize: 11 }}>SB 0 • 0.0 BB / BB 0 • 0.0 BB</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>BB ANTE 0 • 0.0 BB</div>
            </>
          )}
        </div>

        <div ref={potSectionRef} className="rounded-md flex flex-col items-center justify-center" style={{ width: "100%", height: 85, position: "relative", scrollMarginTop: 6, border: "1.5px solid #22C55E", boxShadow: "inset 0 0 16px rgba(34,197,94,0.14), 0 0 10px rgba(34,197,94,0.16)", padding: "7px 8px", textAlign: "center" }}>
          <div style={{ color: "#4ADE80", fontSize: 11, fontWeight: 900 }}>POT</div>
          {torneioMode && torneioContext ? (
            <div style={{ color: "#FFF", fontSize: 11, fontWeight: 900 }}>{fmtChips(Math.round(torneioContext.potBB * (torneioInfo?.bb || 0)))} • {torneioContext.potBB.toFixed(1)} BB</div>
          ) : torneioMode ? (
            <div style={{ color: "#6B7280", fontSize: 11, fontWeight: 900 }}>—</div>
          ) : actionFlowEnabled ? (
            <>
              <div style={{ color: "#FFF", fontSize: 11, fontWeight: 900 }}>{fmtChips(animatedPotChips)} • {animatedPotBB.toFixed(1)} BB</div>
              {/* O detalhamento por camada (MAIN POT / SIDE POT N) mostra só o total aqui — o
                  breakdown completo em multi-shove vive exclusivamente no card SHOVE POTS
                  logo abaixo, pra não repetir a mesma informação duas vezes na tela. */}
            </>
          ) : (
            <div style={{ color: "#FFF", fontSize: 11, fontWeight: 900 }}>0 • 0.0 BB</div>
          )}
          {/* Linha da ação que chega ao herói: posição / ação / valor (fichas - bb) / to call
              (fichas - bb). No treino normal, vem do último evento da própria sequência de
              revelação (actionSequence) — o evento imediatamente antes da vez do herói. No
              Modo Torneio, aproximado pelo assento não-herói com maior valor comprometido
              (o agressor mais provável), já que o motor de torneio não rotula a ação em si. */}
          {torneioMode ? (
            torneioContext && torneioContext.toCallBB > 0.05 && (() => {
              const agressor = (torneioClockwiseSeats || [])
                .filter((s) => !s.isHero && s.displayBetBB > 0)
                .sort((a, b) => b.displayBetBB - a.displayBetBB)[0];
              if (!agressor) return null;
              const posColor = positionBadgeColor(agressor.pos) || "#9CA3AF";
              return (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginTop: 2 }}>
                    <span className="rounded" style={{ color: posColor, border: `1px solid ${posColor}`, background: `${posColor}18`, padding: "1px 5px", fontSize: 10, fontWeight: 900 }}>{agressor.pos}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#9CA3AF" }}>{fmtChips(agressor.displayBetChips)} • {agressor.displayBetBB.toFixed(1)} BB</span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#9CA3AF" }}>
                    <span className="nlh-blink-text" style={{ color: "#FFFFFF" }}>TO CALL</span> {fmtChips(Math.round(torneioContext.toCallBB * (torneioInfo?.bb || 0)))} • {torneioContext.toCallBB.toFixed(1)} BB
                  </div>
                </>
              );
            })()
          ) : (
            actionFlowEnabled && actionSequence.length > 0 && (() => {
              // A "ação que chega ao herói" precisa ser a última AGRESSÃO real da sequência
              // (quem definiu o valor a pagar) — não simplesmente o último evento, que pode ser
              // um FOLD de alguém depois do agressor (mostrar 'FOLD' com um TO CALL do lado não
              // faz sentido: quem chega até o herói é a aposta, não quem desistiu dela).
              const naoAgressivas = new Set(["FOLD", "CHECK", "CALL", "LIMP", "CALL RFI", "CALL 3-BET", "COLD CALL 3-BET"]);
              const agressivas = actionSequence.filter((e) => !naoAgressivas.has(e.action));
              const ultimaAcao = agressivas[agressivas.length - 1] || actionSequence[actionSequence.length - 1];
              const posColor = positionBadgeColor(ultimaAcao.pos) || "#9CA3AF";
              const acaoColor = ultimaAcao.action === "FOLD" ? "#6B7280" : actionSeatColor(ultimaAcao.action);
              return (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginTop: 2 }}>
                    <span className="rounded" style={{ color: posColor, border: `1px solid ${posColor}`, background: `${posColor}18`, padding: "1px 5px", fontSize: 10, fontWeight: 900 }}>{ultimaAcao.pos}</span>
                    <span className="rounded" style={{ color: acaoColor, border: `1px solid ${acaoColor}`, background: `${acaoColor}18`, padding: "1px 5px", fontSize: 10, fontWeight: 900 }}>{ultimaAcao.action}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#9CA3AF" }}>{fmtChips(ultimaAcao.betChips)} • {ultimaAcao.betBB.toFixed(1)} BB</span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#9CA3AF" }}>
                    <span className="nlh-blink-text" style={{ color: "#FFFFFF" }}>TO CALL</span> {fmtChips(spot.callChips || 0)} • {((spot.callChips || 0) / spot.bb).toFixed(1)} BB
                  </div>
                </>
              );
            })()
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(() => {
            // Card do board (e seu título/street label) acompanha a cor da borda do badge de
            // street — verde pré-flop, azul flop, laranja turn, vermelho river.
            const boardStreetColor = streetBadgeColor(spot.street);
            return (
              <div ref={boardSectionRef} className="rounded-md flex flex-col items-center justify-center" style={{ minWidth: 0, position: "relative", height: 65, scrollMarginTop: 6, border: `1.5px solid ${boardStreetColor}`, boxShadow: `0 0 16px ${boardStreetColor}80, 0 0 28px ${boardStreetColor}40`, padding: "8px 0", textAlign: "center" }}>
                {(torneioMode ? false : actionFlowEnabled && spot.board.length > 0) && (
                  <div style={{ fontSize: 11, fontWeight: 900, color: boardStreetColor, letterSpacing: "0.25em", lineHeight: 1.1 }}>{STREET_LABEL_PT[spot.street] || spot.street}</div>
                )}
                <div className="flex items-center justify-center gap-2" style={{ marginTop: (torneioMode ? false : actionFlowEnabled && spot.board.length > 0) ? 4 : 0 }}>
                  {torneioMode
                    ? <span style={{ fontSize: 11, fontWeight: 900, color: boardStreetColor, letterSpacing: "0.3em" }}>PRÉ-FLOP</span>
                    : !actionFlowEnabled
                      ? <span style={{ fontSize: 11, fontWeight: 900, color: boardStreetColor, letterSpacing: "0.3em" }}>---</span>
                      : spot.board.length > 0
                        ? spot.board.map((c, i) => <CardPip key={i} card={c} />)
                        : <span style={{ fontSize: 11, fontWeight: 900, color: boardStreetColor, letterSpacing: "0.3em" }}>PRÉ-FLOP</span>}
                </div>
              </div>
            );
          })()}

          {(() => {
            const heroPos = torneioMode ? torneioContext?.position : (actionFlowEnabled ? spot.heroPosition : null);
            const heroPositionColor = positionBadgeColor(heroPos) || "#3B82F6";
            return (
              <div className="rounded-md flex flex-col items-center justify-center" style={{ minWidth: 0, position: "relative", height: 65, border: `1.5px solid ${heroPositionColor}`, boxShadow: `0 0 14px ${heroPositionColor}61, inset 0 0 12px ${heroPositionColor}1F`, padding: "3px 8px", textAlign: "center" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                  <span style={{ color: heroPositionColor, fontSize: 11, fontWeight: 900, letterSpacing: "0.12em" }}>HERÓI</span>
                  <span className="rounded" style={{ color: heroPositionColor, border: `1px solid ${heroPositionColor}`, background: `${heroPositionColor}18`, padding: "1px 5px", fontSize: 10, fontWeight: 900 }}>{heroPos || "—"}</span>
                </div>
                {torneioMode ? (
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 4 }}>
                    {torneioHeroCards ? (<><CardPip card={torneioHeroCards[0]} /><CardPip card={torneioHeroCards[1]} /></>) : <span style={{ fontSize: 11, color: "#FFF" }}>AGUARDANDO MÃO...</span>}
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <CardPip card={spot.heroCards[0]} hidden={!actionFlowEnabled} />
                    <CardPip card={spot.heroCards[1]} hidden={!actionFlowEnabled} />
                  </div>
                )}
                {/* Relógio de ação continua no card do herói. */}
                {((examMode && sequenceReady && !decision) || (torneioMode && !!torneioContext)) && (
                  <div
                    className={shotClockRemaining <= 5 ? "nlh-blink-text" : undefined}
                    style={{ position: "absolute", right: 6, bottom: 4, fontSize: 11, fontWeight: 900, color: shotClockRemaining <= 5 ? "#EF4444" : "#FFF" }}
                  >
                    ⏱ {shotClockRemaining}S
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {torneioMode && torneioContext && (
          <div className="rounded-md" style={{ width: "100%", border: "1.5px solid #FACC15", padding: "6px 8px" }}>
            <div style={{ color: "#FACC15", fontSize: 11, fontWeight: 900, textAlign: "center" }}>
              {torneioContext.position} · pote {torneioContext.potBB.toFixed(1)}BB · pagar {torneioContext.toCallBB.toFixed(1)}BB
              {!torneioContext.canRaise && <span style={{ color: "#FCA5A5" }}> · all-in incompleto: só pagar ou foldar</span>}
            </div>
          </div>
        )}


        {spot.hasMultiShove && (
          <div className="rounded-md" style={{ border: "1.5px solid #3B82F6", padding: 7, boxShadow: "0 0 10px rgba(59,130,246,0.18)" }}>
            <div style={{ color: "#93C5FD", fontSize: 11, fontWeight: 900, textAlign: "center", marginBottom: 6, letterSpacing: "0.08em" }}>SHOVE POTS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {animatedPotBreakdown.pots.map((potLayer, potIndex) => {
                const layerColor = ["#4ADE80", "#60A5FA", "#C084FC", "#FB923C"][potIndex] || "#FACC15";
                return (
                  <div key={`pot-detail-${potIndex}`} className="rounded" style={{ minHeight: 54, border: `1px solid ${layerColor}`, background: `${layerColor}0D`, padding: "5px 4px", textAlign: "center" }}>
                    <div style={{ color: layerColor, fontSize: 11, fontWeight: 900 }}>{potIndex === 0 ? "MAIN POT" : `SIDE POT ${potIndex}`}</div>
                    <div style={{ color: "#FFF", fontSize: 11, fontWeight: 900 }}>{fmtChips(potLayer.amount)} • {(potLayer.amount / spot.bb).toFixed(1)} BB</div>
                    <div style={{ color: "#9CA3AF", fontSize: 10, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{potLayer.eligible.length ? potLayer.eligible.join(" · ") : "EM FORMAÇÃO"}</div>
                  </div>
                );
              })}
            </div>
            {animatedPotBreakdown.refunds.length > 0 && (
              <div style={{ marginTop: 5, color: "#FACC15", fontSize: 10, fontWeight: 900, textAlign: "center" }}>
                {animatedPotBreakdown.refunds.map((refund) => `${refund.pos}: ${fmtChips(refund.amount)} NÃO COBERTO`).join(" · ")}
              </div>
            )}
            {effectiveMatchups.length > 1 && (
              <div style={{ marginTop: 5, color: "#94A3B8", fontSize: 10, fontWeight: 800, textAlign: "center" }}>
                STACKS EFETIVOS: {effectiveMatchups.map((item) => `${item.pos} ${item.bb.toFixed(1)} BB`).join(" · ")}
              </div>
            )}
          </div>
        )}

        {torneioMode ? (
          <div className="grid grid-cols-2 gap-2" style={{ gridTemplateRows: "repeat(5, minmax(58px, auto))" }}>
            {(torneioClockwiseSeats || []).map((p, i) => {
              const shownAction = p.displayAction || (p.isHero ? "AGUARDANDO" : "---");
              const committedChips = Number(p.displayBetChips || 0);
              const committedBB = Number(p.displayBetBB || 0);
              // No Modo Torneio o ante já sai do BTN dentro do próprio motor (BB ante real) — o
              // stack exibido (p.stackBB) já reflete isso, não precisa subtrair de novo aqui.
              const displayStackChips = Math.max(0, Number(p.stackChips || 0) - committedChips);
              const displayStackBB = Math.max(0, Number(p.stackBB || 0) - committedBB);
              const miniActionColor = shownAction === "---" || shownAction === "AGUARDANDO" ? INACTIVE_SEAT_COLOR : shownAction === "FOLD" ? "#6B7280" : actionSeatColor(shownAction);
              const cardBorderColor = positionBadgeColor(p.pos) || seatColor(p);
              return (
                <div key={i} className={`rounded-md ${p.isActionActive ? "nlh-action-flash" : ""}`} style={{
                  gridRow: p.gridRow,
                  gridColumn: p.gridColumn,
                  minHeight: 58,
                  border: `1.5px solid ${cardBorderColor}`,
                  color: cardBorderColor,
                  opacity: p.opacity,
                  boxShadow: p.isActionActive ? `0 0 14px ${cardBorderColor}` : "none",
                  transition: "opacity 180ms ease, box-shadow 180ms ease",
                  padding: "5px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}>
                  <div style={{ display: "flex", gap: 8, width: "100%" }}>
                    <div className="rounded" style={{ flex: 1, minWidth: 0, color: positionBadgeColor(p.pos) || seatColor(p), border: `1px solid ${positionBadgeColor(p.pos) || seatColor(p)}`, background: `${positionBadgeColor(p.pos) || seatColor(p)}18`, textAlign: "center", padding: "3px 4px", fontSize: 11, fontWeight: 900 }}>{p.pos}</div>
                    <div className="rounded" style={{ flex: 1, minWidth: 0, color: miniActionColor, border: `1px solid ${miniActionColor}`, background: `${miniActionColor}18`, textAlign: "center", padding: "3px 4px", fontSize: 11, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shownAction}</div>
                  </div>
                  <div style={{ color: "#D1D5DB", fontSize: 10, textAlign: "center", whiteSpace: "nowrap" }}><b>S {fmtChips(displayStackChips)} • {displayStackBB.toFixed(1)} BB</b></div>
                </div>
              );
            })}
          </div>
        ) : (
          (() => {
            // Borda/glow do card inteiro acompanham a cor do badge de street (mesma lógica do
            // card do board) — o badge em si migrou pra linha do título (uma vez só por card,
            // perto da borda esquerda) e saiu das linhas individuais dos jogadores.
            const playersStreetColor = streetBadgeColor(spot.street);
            return (
              <div className="rounded-md" style={{ border: `1.5px solid ${playersStreetColor}`, boxShadow: `0 0 10px ${playersStreetColor}2E`, padding: 7 }}>
                {/* Badge de street fica ancorado na borda esquerda (position: absolute) pra não
                    deslocar o título — "JOGADORES COM AÇÃO" fica centralizado na linha inteira do
                    card, não apenas no espaço que sobra depois do badge. */}
                <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 20, marginBottom: 6 }}>
                  <div className="rounded" style={{ position: "absolute", left: 0, color: playersStreetColor, border: `1px solid ${playersStreetColor}`, background: `${playersStreetColor}18`, textAlign: "center", padding: "2px 6px", fontSize: 10, fontWeight: 900, whiteSpace: "nowrap" }}>{STREET_LABEL_PT[spot.street] || spot.street}</div>
                  <div style={{ color: playersStreetColor, fontSize: 11, fontWeight: 900, textAlign: "center", letterSpacing: "0.08em" }}>JOGADORES COM AÇÃO</div>
                </div>
                <div ref={playersSectionRef} className="nlh-action-log-scroll" style={{ height: (() => { const rows = Math.max(1, Math.min(actionLogVisibleRows.length, ACTION_LOG_VISIBLE_ROWS)); return rows * ACTION_LOG_ROW_HEIGHT + (rows - 1) * ACTION_LOG_ROW_GAP; })(), transition: "height 160ms ease", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: ACTION_LOG_ROW_GAP }}>
                  {actionLogVisibleRows.length === 0 && (
                    <div style={{ color: "#6B7280", fontSize: 10, textAlign: "center", padding: "10px 0" }}>—</div>
                  )}
                  {actionLogVisibleRows.map((row, rowIdx) => {
                    const isActiveRow = !!actionLogActiveRow && rowIdx === actionLogVisibleRows.length - 1 && row.key === actionLogActiveRow.key;
                    const isFoldingRow = isActiveRow && row.action === "FOLD";
                    const posColor = positionBadgeColor(row.pos) || "#9CA3AF";
                    const actColor = row.isHero ? heroPromptColor : row.action === "FOLD" ? "#6B7280" : actionSeatColor(row.action);
                    // Linha do herói pendente: pisca/brilha (mesmo efeito e mesma cor — heroPromptColor
                    // via positionBadgeColor — do card HERÓI ao lado do board) enquanto ele ainda não
                    // decidiu; some do "piscando" assim que decision existe, igual ao card HERÓI.
                    const heroPulsing = row.isHero && sequenceReady && !decision;
                    return (
                      <div
                        key={row.key}
                        className={`nlh-log-row ${isFoldingRow ? "nlh-log-row-fold" : ""} ${isActiveRow && !isFoldingRow ? "nlh-action-flash" : ""}`}
                        style={{
                          flex: `0 0 ${ACTION_LOG_ROW_HEIGHT}px`,
                          display: "grid",
                          gridTemplateColumns: "0.6fr 1fr 1.15fr",
                          gap: 6,
                          alignItems: "center",
                          padding: "0 2px",
                          borderRadius: 4,
                        }}
                      >
                        <div
                          className={`nlh-log-cell rounded ${heroPulsing ? "nlh-hero-decision-pulse" : ""}`}
                          style={{ flex: 1, minWidth: 0, color: posColor, border: `1px solid ${posColor}`, background: `${posColor}18`, textAlign: "center", padding: "2px 3px", fontSize: 11, fontWeight: 900 }}
                        >{row.pos}</div>
                        <div className="nlh-log-cell rounded" style={{ color: actColor, border: `1px solid ${actColor}`, background: `${actColor}18`, textAlign: "center", padding: "2px 3px", fontSize: 11, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.action}</div>
                        <div className="nlh-log-cell" style={{ color: "#D1D5DB", fontSize: 10, textAlign: "center", whiteSpace: "nowrap" }}><b>S {fmtChips(row.stackChips)} • {row.stackBB.toFixed(1)} BB</b></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()
        )}


        <div className="grid grid-cols-3 gap-2">
          {(torneioMode && torneioContext ? [
            { key: "FOLD", label: "FOLD", value: "", color: "#EF4444" },
            torneioContext.toCallBB > 0.05
              ? { key: "CALL", label: "CALL", value: `${torneioContext.toCallBB.toFixed(1)} BB`, color: "#3B82F6" }
              : { key: "CHECK", label: "CHECK", value: "", color: "#A855F7" },
            ...[2, 2.5, 3].map((factor) => {
              const amountBB = +(torneioContext.currentBetBB * factor).toFixed(1);
              return { key: `RAISE-${factor}X`, label: "RAISE", value: `${amountBB} BB`, color: "#22C55E", disabled: !torneioContext.canRaise, torneioAmountBB: amountBB };
            }),
            (() => { const amt = +(torneioContext.currentBetBB * 4).toFixed(1); return { key: "RAISE-SQUEEZE", label: "SQUEEZE", value: `${amt} BB`, color: "#EC4899", disabled: !torneioContext.canRaise, torneioAmountBB: amt }; })(),
            (() => { const amt = +(torneioContext.currentBetBB * 6).toFixed(1); return { key: "RAISE-OVERBET", label: "OVER BET", value: `${amt} BB`, color: "#F97316", disabled: !torneioContext.canRaise, torneioAmountBB: amt }; })(),
            { key: "ALL IN", label: "SHOVE", value: `${torneioContext.stackBB.toFixed(1)} BB`, color: "#FACC15" },
          ] : [
            { key: "FOLD", label: "FOLD", value: "", color: "#EF4444", disabled: (!spot.facingBet && !spot.bankEntry) || ["BB_VS_LIMPERS","HU_BB_VS_LIMP"].includes(spot.bankEntry?.strategicNode) },
            { key: "CALL", label: "CALL", value: "", color: "#3B82F6", disabled: !spot.facingBet || (spot.bankEntry && spot.bankEntry.scenario === "RFI") },
            { key: "CHECK", label: "CHECK", value: "", color: "#A855F7", disabled: spot.facingBet || (!!spot.bankEntry && !["BB_VS_LIMPERS","HU_BB_VS_LIMP"].includes(spot.bankEntry?.strategicNode)) },
            ...raiseButtons,
            ...bigBetButtons,
          ]).map((b) => {
            const isTorneioDecision = torneioMode && !!torneioContext;
            const chosen = !isTorneioDecision && decision && decision.action === b.key;
            // b.disabled (calculado por botão, ex.: FOLD desabilitado quando o herói não está
            // facing bet nem tem free-check) precisa realmente bloquear o clique fora do modo
            // torneio também — antes só sequenceReady/currentSpotIsLocked entravam aqui, então
            // era possível clicar FOLD/CHECK numa ação ilegal pro spot: o botão ficava visualmente
            // habilitado e clicável mesmo quando essa ação nem existe na lista de ações legais do
            // motor, gerando um EV de fallback artificial (-99) e um "ERRO GRAVE" sem sentido.
            const blocked = isTorneioDecision ? !!b.disabled : (!!b.disabled || !sequenceReady || currentSpotIsLocked);
            const buttonColor = !isTorneioDecision && rigorMode && !decision ? "#64748B" : b.color;
            const handleClick = (event) => {
              if (isTorneioDecision) {
                if (b.key === "FOLD") return handleTorneioAction("FOLD");
                if (b.key === "CALL" || b.key === "CHECK") return handleTorneioAction("CALL");
                if (b.key === "ALL IN") return handleTorneioAction("SHOVE", torneioContext.stackBB);
                if (b.torneioAmountBB) return handleTorneioAction("RAISE", b.torneioAmountBB);
                return;
              }
              handleAction(b.key, event.timeStamp);
            };
            return (
              <button key={b.key} disabled={blocked} onClick={handleClick} className="rounded-md flex flex-col items-center justify-center" style={{ height: 38, border: `1.5px solid ${buttonColor}`, color: "#FFF", background: "#000", boxShadow: chosen ? `0 0 16px ${b.color}` : !isTorneioDecision && rigorMode && !decision ? "none" : `0 0 8px ${b.color}55`, opacity: isTorneioDecision ? (blocked ? 0.25 : 1) : (!!b.disabled || !sequenceReady || (currentSpotIsLocked && !chosen) ? 0.25 : 1), fontWeight: 900, fontSize: 11, lineHeight: 1.25, cursor: blocked ? "not-allowed" : "pointer" }}>
                <div>{b.label}</div>
                {b.value && <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.85 }}>{b.value}</div>}
              </button>
            );
          })}
          {!(torneioMode && torneioContext) && (
            <>
              <button onClick={() => advance(-1)} className="rounded-md flex items-center justify-center" style={{ height: 38, border: "1.5px solid #FFFFFF", color: "#FFFFFF", background: "#000", fontWeight: 900, fontSize: 11 }}>ANTERIOR</button>
              <button onClick={reviewCurrentHand} disabled={!decision && !currentSpotWasAnswered} className="rounded-md flex items-center justify-center" style={{ height: 38, border: "1.5px solid #22D3EE", color: "#22D3EE", background: "#000", opacity: !decision && !currentSpotWasAnswered ? 0.35 : 1, cursor: !decision && !currentSpotWasAnswered ? "not-allowed" : "pointer", fontWeight: 900, fontSize: 11 }}>REVER MÃO</button>
              <button onClick={() => advance(1)} className="rounded-md flex items-center justify-center" style={{ height: 38, border: "1.5px solid #FFFFFF", color: "#FFFFFF", background: "#000", fontWeight: 900, fontSize: 11 }}>PRÓXIMO</button>
            </>
          )}
        </div>

        {(() => {
          // Estado de espera/timeout/exame mantém as cores fixas de sempre; uma decisão real
          // (fora do exame) passa a usar a cor da própria graduação (verde/laranja/vermelho),
          // com o vermelho do ERRO GRAVE piscando — mesma animação já usada no estado de espera.
          const gradeColor = decision && !decision.timeout && !examMode ? (DECISION_CARD_COLOR[decision.grade] || "#EF4444") : null;
          const cardColor = !decision ? "#FACC15" : decision.timeout ? "#EF4444" : examMode ? "#3B82F6" : gradeColor;
          const cardTextColor = !decision ? "#FACC15" : decision.timeout ? "#EF4444" : examMode ? "#93C5FD" : gradeColor;
          const cardBlinks = !decision || (gradeColor !== null && DECISION_CARD_BLINK_GRADES.has(decision.grade));
          return (
            <div className={`rounded-md flex items-center justify-center ${cardBlinks ? "nlh-blink-border" : ""}`} style={{ height: 35, border: `1.5px solid ${cardColor}`, color: cardTextColor }}>
              <div className={cardBlinks ? "nlh-blink-text" : ""} style={{ display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 11, letterSpacing: "0.06em", textAlign: "center", padding: "0 6px" }}>
                {decision
                  ? (decision.timeout
                      ? "TEMPO ESGOTADO · MÃO CONGELADA"
                      : examMode
                        ? `RESPOSTA REGISTRADA · ${examProgress}/${examLength}`
                        : (DECISION_CARD_ONE_LINER[decision.grade] || decision.grade))
                  : currentSpotWasAnswered && reviewUnlockedSpotKey !== currentSpotKey
                    ? "MÃO FINALIZADA · USE REVER MÃO"
                    : "AGUARDANDO AÇÃO"}
              </div>
            </div>
          );
        })()}

        <div className="flex flex-col gap-2">
          {(() => {
            const points35 = build35PointAnalysis(analysis, spot, fase);
            return (
              <EvaluationPanel revealed={!!decision && !examMode}
                title="MOTOR ESTRATÉGICO — DECISÃO CONSOLIDADA"
                color="#22D3EE"
                action={`${analysis.exploitAction} • MIX: ${mixHeaderText(analysis)}`}
                summary={`Cadeia de 35 indicadores (GTO + exploit) percorrida na ordem — a que mais desviou do baseline neste spot foi: ${analysis.dominantLabel}.`}
                explanation={build35PointExplanation(points35, analysis, decision)}
                lines={build35PointSummaryLines(points35)}
              />
            );
          })()}
        </div>

        <div className="rounded-md flex flex-col gap-2 p-2" style={{ border: "1.5px solid #3B82F6", boxShadow: "0 0 12px rgba(59,130,246,0.3)", textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "#93C5FD", fontWeight: 900, letterSpacing: "0.1em" }}>DESEMPENHO</div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md flex flex-col items-center justify-center" style={{ minHeight: 92, border: "1.5px solid #3B82F6", boxShadow: "0 0 12px rgba(59,130,246,0.3)", padding: "6px 2px" }}>
              <div style={{ color: "#93C5FD", fontWeight: 900, fontSize: 11, letterSpacing: "0.05em" }}>ACERTOS</div>
              <div style={{ color: "#FFF", fontWeight: 900, fontSize: 11, lineHeight: 1.5 }}>{String(partialCorrect).padStart(5,"0")}</div>
              <div style={{ color: "#6B7280", fontWeight: 700, fontSize: 11, lineHeight: 1.5 }}>{partialAccuracyPct.replace(".", ",")}%</div>
              <div style={{ color: "#FFF", fontWeight: 900, fontSize: 11, lineHeight: 1.5 }}>{String(totalCorrect).padStart(5,"0")}</div>
              <div style={{ color: "#6B7280", fontWeight: 700, fontSize: 11, lineHeight: 1.5 }}>{totalAccuracyPct.replace(".", ",")}%</div>
            </div>
            <div className="rounded-md flex flex-col items-center justify-center" style={{ minHeight: 92, border: "1.5px solid #3B82F6", boxShadow: "0 0 12px rgba(59,130,246,0.3)", padding: "6px 2px" }}>
              <div style={{ color: "#93C5FD", fontWeight: 900, fontSize: 11, letterSpacing: "0.05em" }}>REALIZADOS</div>
              <div style={{ color: "#FFF", fontWeight: 900, fontSize: 11, lineHeight: 1.5 }}>{String(partialRealized).padStart(5,"0")}</div>
              <div style={{ color: "#6B7280", fontWeight: 700, fontSize: 11, lineHeight: 1.5 }}>{partialCompletionPct.replace(".", ",")}%</div>
              <div style={{ color: "#FFF", fontWeight: 900, fontSize: 11, lineHeight: 1.5 }}>{String(totalRealized).padStart(5,"0")}</div>
              <div style={{ color: "#6B7280", fontWeight: 700, fontSize: 11, lineHeight: 1.5 }}>{totalCompletionPct.replace(".", ",")}%</div>
            </div>
            <div className="rounded-md flex flex-col items-center justify-center" style={{ minHeight: 92, border: "1.5px solid #3B82F6", boxShadow: "0 0 12px rgba(59,130,246,0.3)", padding: "6px 2px" }}>
              <div style={{ color: "#93C5FD", fontWeight: 900, fontSize: 11, letterSpacing: "0.05em" }}>SPOTS</div>
              <div style={{ color: "#FFF", fontWeight: 900, fontSize: 11, lineHeight: 1.5 }}>{String(spotsCurrentTarget).padStart(5,"0")}</div>
              <div style={{ color: "#6B7280", fontWeight: 700, fontSize: 11, lineHeight: 1.5 }}>{desempenhoSpotsMetaPct.replace(".", ",")}%</div>
              <div style={{ color: "#FFF", fontWeight: 900, fontSize: 11, lineHeight: 1.5 }}>{String(spotsTotalAvailable).padStart(5,"0")}</div>
              <div style={{ color: "#6B7280", fontWeight: 700, fontSize: 11, lineHeight: 1.5 }}>100,0%</div>
            </div>
          </div>

          {/* APAGAR DADOS / MANTER DADOS — decide se o histórico de treino (base de todo o
              card DESEMPENHO) sobrevive a um reinício do app ou começa zerado. */}
          <div style={{ marginTop: 2 }}>
            <div className="grid grid-cols-2" style={{ gap: 8 }}>
              <button onClick={() => handleToggleClick(keepDataOnRestart !== false, true, false, chooseKeepDataOnRestart)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${keepDataOnRestart === false ? "#EF4444" : "#333"}`, background: "transparent", color: keepDataOnRestart === false ? "#FCA5A5" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>
                APAGAR DADOS
              </button>
              <button onClick={() => handleToggleClick(keepDataOnRestart !== false, true, true, chooseKeepDataOnRestart)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${keepDataOnRestart !== false ? "#22C55E" : "#333"}`, background: "transparent", color: keepDataOnRestart !== false ? "#86EFAC" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>
                MANTER DADOS
              </button>
            </div>
          </div>
        </div>

        {/* LEAK FINDER — coleta = history (mãos treinadas no app); varredura = agrupamento por
            posição/street/fase/cenário; comparação = amostra mínima de 5 por grupo; correção =
            os 3 piores por EV perdido médio, com sugestão de qual filtro treinar. Botão liga/
            desliga o relatório automático ao final de cada sessão (meta de spots batida). */}
        <div className="rounded-md flex flex-col gap-2 p-2" style={{ border: "1.5px solid #F97316", boxShadow: "0 0 12px rgba(249,115,22,0.3)", textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "#FDBA74", fontWeight: 900, letterSpacing: "0.1em" }}>LEAK FINDER</div>
          {topLeaks.length === 0 ? (
            <div style={{ fontSize: 11, color: "#9CA3AF" }}>Treine mais mãos (mínimo {MIN_LEAK_SAMPLE} por grupo) pra identificar padrões reais.</div>
          ) : (
            topLeaks.map((leak, i) => (
              <div key={i} className="rounded" style={{ border: "1px solid #F9731655", padding: "6px 8px", textAlign: "left" }}>
                <div style={{ fontSize: 11, color: "#FDBA74", fontWeight: 900 }}>{i + 1}. {leak.label}</div>
                <div style={{ fontSize: 11, color: "#D1D5DB" }}>{leak.n} mãos · {leak.accPct.toFixed(0)}% de acerto · perda média {leak.evLossAvg.toFixed(2)} BB/mão</div>
              </div>
            ))
          )}
          <button onClick={() => setLeakMode((v) => !v)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${leakMode ? "#F97316" : "#333"}`, background: leakMode ? "#F9731618" : "transparent", color: leakMode ? "#FDBA74" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>
            {leakMode ? "LEAK MODE: ATIVADO" : "LEAK MODE: DESATIVADO"}
          </button>
          {leakMode && sessionCompleteNotice && (
            <div className="rounded" style={{ border: "1.5px solid #F97316", padding: "8px", textAlign: "left", background: "rgba(249,115,22,0.06)" }}>
              <div style={{ fontSize: 11, color: "#FDBA74", fontWeight: 900, marginBottom: 4 }}>RELATÓRIO DA SESSÃO</div>
              <div style={{ fontSize: 11, color: "#D1D5DB" }}>{sessionEntries.length} mãos treinadas · {sessionAccPct.toFixed(0)}% de acerto</div>
              {sessionTopLeaks.length === 0 ? (
                <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>Amostra pequena demais pra apontar um ponto fraco específico desta sessão.</div>
              ) : (
                sessionTopLeaks.map((leak, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#D1D5DB", marginTop: 4 }}>
                    <b style={{ color: "#FDBA74" }}>Ponto fraco {i + 1}:</b> {leak.label} — {leak.accPct.toFixed(0)}% de acerto, perda média {leak.evLossAvg.toFixed(2)} BB/mão. Indicação: treine esse filtro especificamente pra corrigir.
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <button onClick={() => setShowSimuladorCards((v) => !v)} className="rounded-md" style={{ height: 38, border: "1.5px solid #22C55E", background: showSimuladorCards ? "#22C55E18" : "transparent", color: "#22C55E", fontWeight: 900, fontSize: 11, letterSpacing: "0.1em" }}>
          MODO SIMULADOR {showSimuladorCards ? "▲" : "▼"}
        </button>

        {showSimuladorCards && (
          <>
        {/* MODO TORNEIO — reposicionado pro final, acima do Modo Prova, no mesmo padrão visual
            amarelo (#22C55E) dos outros cards de treino (ConfigPanel). Configuração vira uma
            gaveta que abre/fecha ao clicar, igual TREINO POR FASE/POSIÇÃO/STREET; o botão de
            ativar/encerrar continua um clique pra cada lado, sem mudar comportamento. */}
        <ConfigPanel
          open={openConfigPanel === "torneioCfg"}
          onToggle={() => setOpenConfigPanel((value) => (value === "torneioCfg" ? null : "torneioCfg"))}
          title="CONFIGURAÇÃO DO TORNEIO"
          summary={`${torneioCfgFieldSize} JOGADORES · ${torneioCfgTipo} · ${torneioCfgFormato} · ${fmtChips(torneioCfgStack)} · ${torneioCfgHandsPerLevel} MÃOS/NÍVEL`}
          color="#22C55E"
          minHeight={45}
        >
          {torneioMode ? (
            <div style={{ color: "#A3A3A3", fontSize: 11, textAlign: "center", padding: "6px 0" }}>ENCERRE O TORNEIO ATUAL PRA MUDAR A CONFIGURAÇÃO</div>
          ) : (
            <>
              <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, marginBottom: 2 }}>CAMPO</div>
              <div className="grid grid-cols-3 gap-2" style={{ marginBottom: 6 }}>
                {TORNEIO_FIELD_SIZES.map((n) => (
                  <button key={n} onClick={() => handleToggleClick(torneioCfgFieldSize, 100, n, setTorneioCfgFieldSize)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${torneioCfgFieldSize === n ? "#22C55E" : "#333"}`, background: torneioCfgFieldSize === n ? "rgba(34,197,94,0.18)" : "transparent", color: torneioCfgFieldSize === n ? "#22C55E" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>{n}</button>
                ))}
              </div>

              <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, marginBottom: 2 }}>TIPO</div>
              <div className="grid grid-cols-2 gap-2" style={{ marginBottom: 6 }}>
                {["NORMAL", "BOUNTY"].map((t) => (
                  <button key={t} onClick={() => handleToggleClick(torneioCfgTipo, "NORMAL", t, setTorneioCfgTipo)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${torneioCfgTipo === t ? "#22C55E" : "#333"}`, background: torneioCfgTipo === t ? "rgba(34,197,94,0.18)" : "transparent", color: torneioCfgTipo === t ? "#22C55E" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>{t}</button>
                ))}
              </div>

              <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, marginBottom: 2 }}>FORMATO</div>
              <div className="grid grid-cols-2 gap-2" style={{ marginBottom: 6 }}>
                {["FREEZEOUT", "REBUY"].map((f) => (
                  <button key={f} onClick={() => handleToggleClick(torneioCfgFormato, "REBUY", f, setTorneioCfgFormato)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${torneioCfgFormato === f ? "#22C55E" : "#333"}`, background: torneioCfgFormato === f ? "rgba(34,197,94,0.18)" : "transparent", color: torneioCfgFormato === f ? "#22C55E" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>{f}</button>
                ))}
              </div>

              {torneioCfgFormato === "REBUY" && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, marginBottom: 2 }}>ADD-ON (NÍVEL 12)</div>
                  <div className="grid grid-cols-2" style={{ gap: 8 }}>
                    <button onClick={() => handleToggleClick(torneioCfgTakesAddOn, true, false, setTorneioCfgTakesAddOn)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${!torneioCfgTakesAddOn ? "#FACC15" : "#333"}`, background: "transparent", color: !torneioCfgTakesAddOn ? "#FACC15" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>
                      SEM ADD-ON
                    </button>
                    <button onClick={() => handleToggleClick(torneioCfgTakesAddOn, true, true, setTorneioCfgTakesAddOn)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${torneioCfgTakesAddOn ? "#FACC15" : "#333"}`, background: "transparent", color: torneioCfgTakesAddOn ? "#FACC15" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>
                      COM ADD-ON
                    </button>
                  </div>
                </div>
              )}

              <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, marginBottom: 2 }}>STACK INICIAL</div>
              <div className="grid grid-cols-3 gap-2" style={{ marginBottom: 6 }}>
                {TORNEIO_STARTING_STACKS.map((s) => (
                  <button key={s} onClick={() => handleToggleClick(torneioCfgStack, 40000, s, setTorneioCfgStack)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${torneioCfgStack === s ? "#22C55E" : "#333"}`, background: torneioCfgStack === s ? "rgba(34,197,94,0.18)" : "transparent", color: torneioCfgStack === s ? "#22C55E" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>{fmtChips(s)}</button>
                ))}
              </div>

              <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, marginBottom: 2 }}>MÃOS POR NÍVEL</div>
              <div className="grid grid-cols-3 gap-2">
                {TORNEIO_HANDS_PER_LEVEL_OPTIONS.map((h) => (
                  <button key={h} onClick={() => handleToggleClick(torneioCfgHandsPerLevel, 40, h, setTorneioCfgHandsPerLevel)} className="rounded-md" style={{ height: 30, border: `1.5px solid ${torneioCfgHandsPerLevel === h ? "#22C55E" : "#333"}`, background: torneioCfgHandsPerLevel === h ? "rgba(34,197,94,0.18)" : "transparent", color: torneioCfgHandsPerLevel === h ? "#22C55E" : "#9CA3AF", fontWeight: 900, fontSize: 11 }}>{h}</button>
                ))}
              </div>
            </>
          )}

          {/* Relatório do torneio — DENTRO da gaveta de configuração (não é mais um card
              separado), e separado do relatório geral/histórico de revisão do resto do app.
              Só aparece depois que o torneio termina de verdade (bust ou campeão). */}
          {torneioReport && (
            <div className="rounded-md" style={{ width: "100%", border: "1.5px solid #22C55E", padding: "9px 10px" }}>
              <div style={{ height: 35, display: "flex", alignItems: "center", justifyContent: "center", color: "#22C55E", fontSize: 11, fontWeight: 900, letterSpacing: "0.1em" }}>RELATÓRIO DO TORNEIO</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#DCFCE7", lineHeight: 1.5, whiteSpace: "pre-line" }}>
                {formatTournamentReportText(torneioReport)}
              </div>
              <div className="grid grid-cols-2 gap-2" style={{ marginTop: 8 }}>
                <a
                  href={`mailto:?subject=${encodeURIComponent("Relatório do Torneio — Stackup Hold'em Pro")}&body=${encodeURIComponent(formatTournamentReportText(torneioReport))}`}
                  className="rounded-md flex items-center justify-center"
                  style={{ height: 30, border: "1.5px solid #22C55E", color: "#22C55E", textDecoration: "none", fontWeight: 900, fontSize: 11 }}
                >
                  📧 E-MAIL
                </a>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(formatTournamentReportText(torneioReport))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md flex items-center justify-center"
                  style={{ height: 30, border: "1.5px solid #22C55E", color: "#86EFAC", textDecoration: "none", fontWeight: 900, fontSize: 11 }}
                >
                  💬 WHATSAPP
                </a>
              </div>
            </div>
          )}
        </ConfigPanel>

        <div onClick={() => (torneioMode ? stopTorneio() : startTorneio())} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { if (torneioMode) stopTorneio(); else startTorneio(); } }} className="rounded-md cursor-pointer flex flex-col items-center justify-center" style={{ height: 60, border: "1.5px solid #22C55E", background: torneioMode ? "#22C55E1A" : "transparent", boxShadow: torneioMode ? "0 0 14px rgba(34,197,94,0.35)" : "none", padding: "0 8px" }}>
          <div style={{ color: "#22C55E", fontSize: 11, fontWeight: 900, textAlign: "center", letterSpacing: "0.06em" }}>
            {torneioMode ? "MODO TORNEIO ATIVO" : "MODO TORNEIO"}
          </div>
          <div style={{ color: "#FFF", fontSize: 10, textAlign: "center" }}>
            {torneioMode ? "CLIQUE NOVAMENTE PARA ENCERRAR" : "CLIQUE PARA ATIVAR"}
          </div>
        </div>

        {/* Histórico entre torneios (ranking) — card À PARTE, separado do relatório de UM
            torneio e do histórico/revisão do resto do app. Persistente (localStorage), visível
            sempre que existir pelo menos um torneio já registrado, dentro ou fora do Modo
            Torneio. */}
        {totalTournamentsPlayed(torneioRankingHistogram) > 0 && (
          <div className="rounded-md" style={{ width: "100%", border: "1.5px solid #22C55E", padding: "8px 10px" }}>
            <div style={{ height: 35, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "#22C55E", fontSize: 11, fontWeight: 900, letterSpacing: "0.1em" }}>HISTÓRICO DE TORNEIOS</span>
              <span style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800 }}>{totalTournamentsPlayed(torneioRankingHistogram)} JOGADOS</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {summarizeRankingHistogram(torneioRankingHistogram).map(({ rank, count }) => (
                <div key={rank} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: "#22C55E" }}>
                  <span>{rank === 1 ? "🏆 1º lugar" : `${rank}º lugar`}</span>
                  <span>{count}x</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {torneioMode && torneioInfo && (
          <div className="rounded-md" style={{ width: "100%", border: "1.5px solid #22C55E", boxShadow: "0 0 14px rgba(34,197,94,0.35), inset 0 0 12px rgba(34,197,94,0.1)", padding: "8px 10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ color: "#22C55E", fontSize: 11, fontWeight: 900, letterSpacing: "0.1em" }}>MODO TORNEIO</span>
              <span style={{ color: "#4ADE80", fontSize: 11, fontWeight: 900 }}>ATIVADO</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 11, fontWeight: 800, color: "#22C55E" }}>
              <div>{String(torneioInfo.jogadores).padStart(3, "0")} JOGADORES</div>
              <div>{String(torneioInfo.mesas).padStart(3, "0")} MESAS</div>
              <div>{torneioInfo.tipo === "BOUNTY" ? "BOUNTY" : "NORMAL"}</div>
              <div>{torneioInfo.formato === "REBUY" ? "REBUY" : "FREEZEOUT"}</div>
              <div>STACK TOTAL: {fmtChips(torneioInfo.stackTotal)}</div>
              <div>STACK MÉDIO: {fmtChips(torneioInfo.stackMedio)}</div>
            </div>
          </div>
        )}


        <ConfigPanel
          open={openConfigPanel === "modoProva"}
          onToggle={() => setOpenConfigPanel((value) => value === "modoProva" ? null : "modoProva")}
          title="MODO PROVA"
          summary={examMode ? `ATIVO · ${examProgress}/${examLength}` : `${examLength} SPOTS`}
          color="#22C55E"
        >
          <div className="grid grid-cols-3 gap-2">
            {[25, 50, 100].map((length) => <button key={length} onClick={() => handleToggleClick(examLength, 25, length, setExamLength)} disabled={examMode} className="rounded" style={{ height: 30, border: examLength === length ? "1px solid #22C55E" : "1px solid #333", color: examLength === length ? "#FFF" : "#9CA3AF", background: examLength === length ? "#22C55E18" : "transparent", boxShadow: examLength === length ? "0 0 8px rgba(34,197,94,0.25)" : "none", fontSize: 11, fontWeight: 900, opacity: examMode ? 0.4 : 1, cursor: examMode ? "not-allowed" : "pointer" }}>{length} SPOTS</button>)}
          </div>
          <button onClick={toggleExam} className="rounded-md" style={{ width: "100%", height: 35, border: "1.5px solid #22C55E", background: examMode ? "rgba(34,197,94,0.14)" : "rgba(34,197,94,0.08)", color: "#FFF", fontWeight: 900, fontSize: 11 }}>
            {examMode ? (examProgress >= examLength ? "PROVA CONCLUÍDA · CLIQUE PARA ZERAR E DESATIVAR" : "SEM FEEDBACK IMEDIATO · CLIQUE PARA ZERAR E DESATIVAR") : "CLIQUE PARA ATIVAR"}
          </button>

          {/* Relatório da prova — DENTRO da gaveta de Modo Prova (mesmo padrão do relatório do
              Modo Torneio, que também vive dentro da própria gaveta de configuração). */}
          {examReport && (
            <div className="rounded-md" style={{ border: "1.5px solid #22C55E", padding: 8, marginTop: 2 }}>
              <div style={{ color: "#22C55E", fontSize: 11, fontWeight: 900, textAlign: "center", marginBottom: 7 }}>RELATÓRIO DA PROVA · {examReport.count} SPOTS</div>
              <div className="grid grid-cols-3 gap-2">
                {[['PRECISÃO', `${examReport.accuracy.toFixed(1).replace('.', ',')}%`], ['EV PERDIDO', `${examReport.totalLoss.toFixed(2).replace('.', ',')} BB`], ['TEMPO MÉDIO', `${examReport.avgTime.toFixed(1).replace('.', ',')} S`]].map(([label, value]) => <div key={label} className="rounded" style={{ border: "1px solid #22C55E", padding: 6, textAlign: "center" }}><div style={{ color: "#22C55E", fontSize: 10, fontWeight: 900 }}>{label}</div><div style={{ color: "#FFF", fontSize: 13, fontWeight: 900 }}>{value}</div></div>)}
              </div>
              <div style={{ borderTop: "1px solid #22C55E", color: "#FCA5A5", fontSize: 11, marginTop: 7, paddingTop: 6 }}><b>MAIOR LEAK:</b> {String(examReport.leak).replaceAll('_', ' ')}</div>
              <div style={{ color: "#86EFAC", fontSize: 11, marginTop: 3 }}><b>MELHOR ÁREA:</b> {String(examReport.strength).replaceAll('_', ' ')}</div>
              <div style={{ color: "#BFDBFE", fontSize: 11, marginTop: 3 }}><b>PRÓXIMO TREINO:</b> {examReport.recommendation}</div>
            </div>
          )}
        </ConfigPanel>
          </>
        )}

        <div className="grid grid-cols-3 gap-2">
          <button onClick={() => advance(-1)} className="rounded-md flex items-center justify-center" style={{ height: 38, border: "1.5px solid #FFFFFF", color: "#FFFFFF", background: "#000", fontSize: 11, fontWeight: 900 }}>
            ANTERIOR
          </button>
          <button onClick={reviewCurrentHand} disabled={!decision && !currentSpotWasAnswered} className="rounded-md flex items-center justify-center" style={{ height: 38, border: "1.5px solid #22D3EE", color: "#22D3EE", background: "#000", opacity: !decision && !currentSpotWasAnswered ? 0.35 : 1, cursor: !decision && !currentSpotWasAnswered ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 900 }}>
            REVER MÃO
          </button>
          <button onClick={() => advance(1)} className="rounded-md flex items-center justify-center" style={{ height: 38, border: "1.5px solid #FFFFFF", color: "#FFFFFF", background: "#000", fontSize: 11, fontWeight: 900 }}>
            PRÓXIMO
          </button>
        </div>

        <ConfigPanel
          open={historyPanelOpen}
          onToggle={toggleReportPanel}
          title="RELATÓRIO E HISTÓRICO"
          summary={`${history.length} SPOTS`}
          color="#06B6D4"
        >
          <div ref={reportPanelRef} className="flex flex-col gap-2" style={{ scrollMarginTop: 12 }}>
            <div className="flex items-center justify-between gap-2">
              <div style={{ fontSize: 11, fontWeight: 900, color: "#67E8F9" }}>
                TOTAL: {history.length} SPOTS • ACERTOS: {history.filter((h) => h.correct).length} ({history.length > 0 ? ((history.filter((h) => h.correct).length / history.length) * 100).toFixed(1) : "0.0"}%)
              </div>
              <button onClick={clearHistory} disabled={history.length === 0} className="rounded-md" style={{ height: 28, minWidth: 84, border: "1.5px solid #EF4444", color: "#FCA5A5", background: "rgba(239,68,68,0.1)", fontWeight: 900, fontSize: 11, opacity: history.length === 0 ? 0.35 : 1, cursor: history.length === 0 ? "not-allowed" : "pointer" }}>
                LIMPAR
              </button>
            </div>

            <div className="flex flex-col gap-2" style={{ maxHeight: 180, overflowY: "auto" }}>
              {history.length === 0 && <div style={{ fontSize: 11, color: "#6B7280" }}>Nenhum spot treinado ainda nesta sessão.</div>}
              {history.slice(-30).reverse().map((h, i) => (
                <div key={i} style={{ fontSize: 11, color: h.correct ? "#86EFAC" : "#FCA5A5", borderLeft: `2px solid ${h.correct ? "#22C55E" : "#EF4444"}`, paddingLeft: 6 }}>
                  {faseDisplayLabel(h.fase)} / {h.street} / {h.position} — {h.heroInfo} — VOCÊ: {h.action} · CERTO: {h.correctAction}
                </div>
              ))}
            </div>

            <input
              type="email" placeholder="SEU E-MAIL" value={userEmail}
              onChange={(e) => updateContactField(e.target.value, userWhatsapp)}
              onBlur={persistContacts}
              style={{ height: 38, background: "#000", border: "1.5px solid #06B6D4", borderRadius: 6, color: "#FFF", fontSize: 11, padding: "0 8px" }}
            />
            <input
              type="tel" placeholder="SEU WHATSAPP (COM DDD)" value={userWhatsapp}
              onChange={(e) => updateContactField(userEmail, e.target.value)}
              onBlur={persistContacts}
              style={{ height: 38, background: "#000", border: "1.5px solid #06B6D4", borderRadius: 6, color: "#FFF", fontSize: 11, padding: "0 8px" }}
            />

            <div className="grid grid-cols-2 gap-2">
              <button onClick={sendHistoryWhatsapp} disabled={history.length === 0} className="rounded-md" style={{ height: 44, border: "1.5px solid #22C55E", color: "#86EFAC", background: "rgba(34,197,94,0.1)", fontWeight: 900, fontSize: 11, opacity: history.length === 0 ? 0.4 : 1 }}>
                ENVIAR POR WHATSAPP
              </button>
              <button onClick={sendHistoryEmail} disabled={history.length === 0} className="rounded-md" style={{ height: 44, border: "1.5px solid #3B82F6", color: "#93C5FD", background: "rgba(59,130,246,0.1)", fontWeight: 900, fontSize: 11, opacity: history.length === 0 ? 0.4 : 1 }}>
                ENVIAR POR E-MAIL
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Exporta o resumo geral + as últimas 30 decisões. Abre o WhatsApp/e-mail com a mensagem pronta para você conferir e enviar.</div>

            <button onClick={runAiReport} disabled={aiReportLoading} className="rounded-md" style={{ height: 44, border: "1.5px solid #A855F7", color: "#FFF", background: aiReportLoading ? "#4B5563" : "rgba(168,85,247,0.25)", fontWeight: 900, fontSize: 11 }}>
              {aiReportLoading ? "GERANDO RELATÓRIO..." : "GERAR RELATÓRIO COM IA"}
            </button>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Usa o provedor e a chave configurados em INTEGRAR IA para analisar seus pontos fortes e fracos.</div>
            {aiReportError && <div style={{ fontSize: 11, color: "#FCA5A5", lineHeight: 1.5 }}>{aiReportError}</div>}
            {aiReport && <div style={{ fontSize: 11, color: "#D8B4FE", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{aiReport}</div>}
          </div>
        </ConfigPanel>

      </div>
    </div>
  );
}
