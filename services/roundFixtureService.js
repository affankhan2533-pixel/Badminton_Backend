import crypto from "crypto";
import Match from "../models/Match.js";
import Player from "../models/Player.js";
import Team from "../models/Team.js";
import Round from "../models/Round.js";
import TournamentSettings from "../models/TournamentSettings.js";
import TournamentPoint from "../models/TournamentPoint.js";
import { isDoublesCategory } from "./scoringEngine.js";

/**
 * Retrieves all active registered competitors for a given category.
 * For Singles: Active Players matching category and gender.
 * For Doubles: Active Teams registered for that category.
 */
export async function getRegisteredCompetitors(category) {
  const isDoubles = isDoublesCategory(category);

  if (isDoubles) {
    const teams = await Team.find({ category, status: "Active" }).sort({ created_at: 1, name: 1 });
    return teams.map((t, idx) => ({
      id: t.id,
      name: t.name,
      type: "team",
      player1_id: t.player1_id,
      player2_id: t.player2_id,
      category,
      seed: idx + 1,
      advancementReason: "initial_draw",
    }));
  } else {
    const isFemale = category.includes("Women's");
    const gender = isFemale ? "Female" : "Male";
    const players = await Player.find({
      registration_status: "Active",
      gender,
      eligible_categories: category,
    }).sort({ created_at: 1, full_name: 1 });

    return players.map((p, idx) => ({
      id: p.id,
      name: p.full_name,
      type: "player",
      player1_id: p.id,
      player2_id: null,
      category,
      seed: idx + 1,
      advancementReason: "initial_draw",
    }));
  }
}

/**
 * Determines appropriate round display name based on roundNumber and remaining team count.
 */
export function determineRoundName(roundNumber, remainingCount) {
  if (remainingCount === 2) return "Final";
  if (remainingCount >= 3 && remainingCount <= 4) return "Semi-finals";
  if (remainingCount >= 5 && remainingCount <= 8) return "Quarter-finals";
  if (remainingCount >= 9 && remainingCount <= 16) return "Round of 16";
  if (remainingCount >= 17 && remainingCount <= 32) return "Round of 32";
  return `Round ${roundNumber}`;
}

/**
 * Cryptographic / unbiased Fisher-Yates shuffle
 */
export function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    let j;
    try {
      j = crypto.randomInt(0, i + 1);
    } catch (_) {
      j = Math.floor(Math.random() * (i + 1));
    }
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Generates Round 1 fixtures and bye allocation.
 * If total teams is ODD: selects exactly ONE random team for a BYE.
 * Remaining teams are randomized and paired.
 */
export function generateRound1Fixtures({ competitors, category, availableCourts = 4 }) {
  if (!competitors || competitors.length < 2) {
    throw new Error("At least 2 registered competitors are required to create a round.");
  }

  // 1. Randomize draw
  const shuffled = shuffleArray(competitors);
  const isOdd = shuffled.length % 2 !== 0;

  let byeTeam = null;
  let pairingPool = [];

  if (isOdd) {
    // Select one random team to receive a BYE
    const byeIdx = Math.floor(Math.random() * shuffled.length);
    byeTeam = {
      ...shuffled[byeIdx],
      advancementReason: "bye",
    };
    pairingPool = shuffled.filter((_, idx) => idx !== byeIdx);
  } else {
    pairingPool = [...shuffled];
  }

  const fixtures = [];
  const pairingExplanations = [];
  const matchCount = pairingPool.length / 2;

  for (let i = 0; i < matchCount; i++) {
    const teamA = pairingPool[i * 2];
    const teamB = pairingPool[i * 2 + 1];
    const matchNumber = i + 1;
    const courtNumber = ((i) % availableCourts) + 1;

    fixtures.push({
      match_number: matchNumber,
      category,
      roundNumber: 1,
      round: determineRoundName(1, competitors.length),
      court_number: courtNumber,
      status: "scheduled",
      team_a_id: teamA.id,
      team_a_name: teamA.name,
      team_a_player1_id: teamA.player1_id,
      team_a_player2_id: teamA.player2_id || null,
      team_b_id: teamB.id,
      team_b_name: teamB.name,
      team_b_player1_id: teamB.player1_id,
      team_b_player2_id: teamB.player2_id || null,
    });

    pairingExplanations.push({
      matchNumber,
      teamA: teamA.name,
      teamB: teamB.name,
      teamA_rank: teamA.seed || (i * 2 + 1),
      teamB_rank: teamB.seed || (i * 2 + 2),
      teamA_points: 0,
      teamB_points: 0,
      explanation: `Round 1 randomized draw: ${teamA.name} vs ${teamB.name}`,
    });
  }

  return {
    roundNumber: 1,
    roundName: determineRoundName(1, competitors.length),
    totalTeams: competitors.length,
    participatingTeams: competitors,
    byeTeam,
    fixtures,
    pairingExplanations,
  };
}

/**
 * Computes category standings for a list of teams using completed matches in that category.
 * Used for deterministic ranking of qualified teams for subsequent rounds.
 */
export async function computeCategoryStandings(category, roundNumberFilter = null) {
  const matchFilter = { category, status: "completed" };
  if (roundNumberFilter !== null && roundNumberFilter !== undefined) {
    matchFilter.roundNumber = roundNumberFilter;
  }

  const completedMatches = await Match.find(matchFilter);
  let settings = await TournamentSettings.findOne({ id: "default" });
  if (!settings) settings = { points_per_win: 3, points_per_participation: 1 };

  const winPoints = settings.points_per_win || 3;
  const partPoints = settings.points_per_participation || 1;

  // Aggregate stats per team
  const statsMap = new Map();

  function getOrCreate(id, name, type) {
    if (!statsMap.has(id)) {
      statsMap.set(id, {
        id,
        name,
        type: type || (isDoublesCategory(category) ? "team" : "player"),
        matches_played: 0,
        matches_won: 0,
        matches_lost: 0,
        points_scored: 0,
        points_conceded: 0,
        rally_difference: 0,
        total_points: 0,
        head_to_head: {}, // otherTeamId -> win/loss count
      });
    }
    return statsMap.get(id);
  }

  for (const m of completedMatches) {
    const idA = m.team_a_id || m.team_a_player1_id;
    const idB = m.team_b_id || m.team_b_player1_id;
    const isWinnerA = m.winner_team === "A";

    const statA = getOrCreate(idA, m.team_a_name);
    const statB = getOrCreate(idB, m.team_b_name);

    statA.matches_played += 1;
    statB.matches_played += 1;

    statA.points_scored += m.score_a || 0;
    statA.points_conceded += m.score_b || 0;
    statB.points_scored += m.score_b || 0;
    statB.points_conceded += m.score_a || 0;

    if (isWinnerA) {
      statA.matches_won += 1;
      statB.matches_lost += 1;
      statA.total_points += winPoints + partPoints;
      statB.total_points += partPoints;
      statA.head_to_head[idB] = (statA.head_to_head[idB] || 0) + 1;
    } else {
      statB.matches_won += 1;
      statA.matches_lost += 1;
      statB.total_points += winPoints + partPoints;
      statA.total_points += partPoints;
      statB.head_to_head[idA] = (statB.head_to_head[idA] || 0) + 1;
    }

    statA.rally_difference = statA.points_scored - statA.points_conceded;
    statB.rally_difference = statB.points_scored - statB.points_conceded;
  }

  const standings = Array.from(statsMap.values());

  // Sort standings with the official 6-tier tie-breaking criteria:
  // 1. Total tournament points (highest first)
  // 2. Total match victories (highest first)
  // 3. Rally point difference (highest first)
  // 4. Total rally points scored (highest first)
  // 5. Head-to-head result between the two teams
  // 6. Deterministic alphabetical/ID tie-breaker
  standings.sort((a, b) => {
    if (b.total_points !== a.total_points) return b.total_points - a.total_points;
    if (b.matches_won !== a.matches_won) return b.matches_won - a.matches_won;
    if (b.rally_difference !== a.rally_difference) return b.rally_difference - a.rally_difference;
    if (b.points_scored !== a.points_scored) return b.points_scored - a.points_scored;

    // Head-to-head
    const h2hA = a.head_to_head[b.id] || 0;
    const h2hB = b.head_to_head[a.id] || 0;
    if (h2hA !== h2hB) return h2hB - h2hA;

    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  // Assign 1-based ranks
  standings.forEach((item, index) => {
    item.rank = index + 1;
  });

  return standings;
}

/**
 * Generates Round 2+ (Subsequent Round) fixtures using the official Points Table standings.
 * - Only qualified teams from the previous round enter.
 * - Teams are sorted strictly by standings.
 * - If odd number of teams: the highest-ranked qualified team receives a BYE.
 * - Remaining teams paired 1 vs N (highest vs lowest remaining).
 */
export async function generateSubsequentRoundFixtures({
  category,
  roundNumber,
  qualifiedTeams,
  availableCourts = 4,
}) {
  if (!qualifiedTeams || qualifiedTeams.length < 2) {
    throw new Error("At least 2 qualified teams are required to generate the next round.");
  }

  // Get cumulative category standings to rank the qualified teams
  const categoryStandings = await computeCategoryStandings(category);
  const standingsMap = new Map(categoryStandings.map((s) => [s.id, s]));

  // Attach standings info to each qualified team (safely unwrap Mongoose subdocuments)
  const enrichedQualified = qualifiedTeams.map((rawQt) => {
    const qt = rawQt && typeof rawQt.toObject === "function" ? rawQt.toObject() : { ...rawQt };
    const stats = standingsMap.get(qt.id) || {
      total_points: 0,
      matches_won: 0,
      rally_difference: 0,
      points_scored: 0,
      rank: 999,
    };
    return {
      ...qt,
      total_points: stats.total_points || 0,
      matches_won: stats.matches_won || 0,
      rally_difference: stats.rally_difference || 0,
      points_scored: stats.points_scored || 0,
      standings_rank: stats.rank || 999,
    };
  });

  // Sort qualified teams strictly by standings criteria
  enrichedQualified.sort((a, b) => {
    if (b.total_points !== a.total_points) return b.total_points - a.total_points;
    if (b.matches_won !== a.matches_won) return b.matches_won - a.matches_won;
    if (b.rally_difference !== a.rally_difference) return b.rally_difference - a.rally_difference;
    if (b.points_scored !== a.points_scored) return b.points_scored - a.points_scored;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  // Assign internal seed order 1..M
  enrichedQualified.forEach((t, i) => {
    t.seed = i + 1;
  });

  const isOdd = enrichedQualified.length % 2 !== 0;
  let byeTeam = null;
  let pairingPool = [];

  if (isOdd) {
    // Default rule: the highest-ranked eligible qualifying team receives the bye!
    byeTeam = {
      ...enrichedQualified[0],
      advancementReason: "bye",
    };
    pairingPool = enrichedQualified.slice(1);
  } else {
    pairingPool = [...enrichedQualified];
  }

  const roundName = determineRoundName(roundNumber, enrichedQualified.length);
  const fixtures = [];
  const pairingExplanations = [];
  const matchCount = pairingPool.length / 2;

  // Pair highest-ranked vs lowest-ranked (1 vs N, 2 vs N-1...)
  for (let i = 0; i < matchCount; i++) {
    const teamA = pairingPool[i];
    const teamB = pairingPool[pairingPool.length - 1 - i];
    const matchNumber = i + 1;
    const courtNumber = (i % availableCourts) + 1;

    fixtures.push({
      match_number: matchNumber,
      category,
      roundNumber,
      round: roundName,
      court_number: courtNumber,
      status: "scheduled",
      team_a_id: teamA.id,
      team_a_name: teamA.name,
      team_a_player1_id: teamA.player1_id,
      team_a_player2_id: teamA.player2_id || null,
      team_b_id: teamB.id,
      team_b_name: teamB.name,
      team_b_player1_id: teamB.player1_id,
      team_b_player2_id: teamB.player2_id || null,
    });

    pairingExplanations.push({
      matchNumber,
      teamA: teamA.name,
      teamB: teamB.name,
      teamA_rank: teamA.seed,
      teamB_rank: teamB.seed,
      teamA_points: teamA.total_points,
      teamB_points: teamB.total_points,
      explanation: `Standings-based pairing: Seed #${teamA.seed} (${teamA.name}, ${teamA.total_points} pts, ${teamA.rally_difference > 0 ? "+" : ""}${teamA.rally_difference} diff) vs Seed #${teamB.seed} (${teamB.name}, ${teamB.total_points} pts, ${teamB.rally_difference > 0 ? "+" : ""}${teamB.rally_difference} diff)`,
    });
  }

  return {
    roundNumber,
    roundName,
    totalTeams: enrichedQualified.length,
    participatingTeams: enrichedQualified,
    byeTeam,
    fixtures,
    pairingExplanations,
  };
}
