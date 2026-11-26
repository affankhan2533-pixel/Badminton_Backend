import mongoose from "mongoose";
import Round from "../models/Round.js";
import Match from "../models/Match.js";
import Player from "../models/Player.js";
import Team from "../models/Team.js";
import TournamentSettings from "../models/TournamentSettings.js";
import {
  getRegisteredCompetitors,
  determineRoundName,
  generateRound1Fixtures,
  generateSubsequentRoundFixtures,
  computeCategoryStandings,
} from "../services/roundFixtureService.js";
import { isDoublesCategory } from "../services/scoringEngine.js";
import { syncMatchToSqlite } from "../services/sqliteSync.js";
import { realtime } from "../services/realtimeService.js";

function roundQuery(identifier) {
  if (!identifier) return { id: null };
  return mongoose.isValidObjectId(identifier) ? { $or: [{ id: identifier }, { _id: identifier }] } : { id: identifier };
}

/**
 * Preview fixtures before creating or publishing a round.
 * Does not mutate the database.
 */
export async function previewRound(req, res) {
  try {
    const { category, roundNumber } = req.body;
    if (!category) {
      return res.status(400).json({ error: "Category is required." });
    }

    const settings = (await TournamentSettings.findOne({ id: "default" })) || {};
    const courts = settings.number_of_courts || 4;

    const existingRounds = await Round.find({ category }).sort({ roundNumber: 1 });
    const nextRoundNum = roundNumber || (existingRounds.length === 0 ? 1 : existingRounds.length + 1);

    if (nextRoundNum === 1) {
      // Check if Round 1 already exists
      const r1 = existingRounds.find((r) => r.roundNumber === 1);
      if (r1 && r1.status !== "draft") {
        return res.status(400).json({
          error: "Round 1 already exists for this category. Reset or proceed to next round.",
        });
      }

      const competitors = await getRegisteredCompetitors(category);
      if (competitors.length < 2) {
        return res.status(400).json({
          error: `Category "${category}" requires at least 2 registered competitors. Found: ${competitors.length}.`,
        });
      }

      const preview = generateRound1Fixtures({
        competitors,
        category,
        availableCourts: courts,
      });

      return res.json({ success: true, preview });
    } else {
      // Subsequent round: previous round MUST be completed
      const prevRound = existingRounds.find((r) => r.roundNumber === nextRoundNum - 1);
      if (!prevRound) {
        return res.status(400).json({
          error: `Cannot create Round ${nextRoundNum}: Previous Round ${nextRoundNum - 1} does not exist.`,
        });
      }

      if (prevRound.status !== "completed") {
        return res.status(400).json({
          error: `Cannot create Round ${nextRoundNum}: Round ${prevRound.roundNumber} is still in progress with pending matches.`,
        });
      }

      const qualifiedTeams = prevRound.qualifiedTeams || [];
      if (qualifiedTeams.length < 2) {
        return res.status(400).json({
          error: `Tournament concluded or insufficient qualified teams (Found: ${qualifiedTeams.length}).`,
        });
      }

      const preview = await generateSubsequentRoundFixtures({
        category,
        roundNumber: nextRoundNum,
        qualifiedTeams,
        availableCourts: courts,
      });

      return res.json({ success: true, preview });
    }
  } catch (error) {
    console.error("previewRound error:", error);
    return res.status(400).json({ error: error.message || "Failed to generate fixture preview." });
  }
}

/**
 * Creates and optionally publishes a round.
 */
export async function createRound(req, res) {
  try {
    const { category, roundNumber, publishNow = false } = req.body;
    if (!category) {
      return res.status(400).json({ error: "Category is required." });
    }

    const settings = (await TournamentSettings.findOne({ id: "default" })) || {};
    const courts = settings.number_of_courts || 4;

    const existingRounds = await Round.find({ category }).sort({ roundNumber: 1 });
    const targetRoundNum = Number(roundNumber) || (existingRounds.length === 0 ? 1 : existingRounds.length + 1);

    // Prevent duplicate round
    const existingSame = existingRounds.find((r) => r.roundNumber === targetRoundNum);
    if (existingSame && existingSame.status !== "draft") {
      return res.status(400).json({
        error: `Round ${targetRoundNum} for "${category}" already exists with status: ${existingSame.status}.`,
      });
    }

    let fixtureData;
    if (targetRoundNum === 1) {
      const competitors = await getRegisteredCompetitors(category);
      if (competitors.length < 2) {
        return res.status(400).json({
          error: `Category "${category}" requires at least 2 registered competitors. Found: ${competitors.length}.`,
        });
      }
      fixtureData = generateRound1Fixtures({ competitors, category, availableCourts: courts });
    } else {
      const prevRound = existingRounds.find((r) => r.roundNumber === targetRoundNum - 1);
      if (!prevRound || prevRound.status !== "completed") {
        return res.status(400).json({
          error: `Previous round must be completed before generating Round ${targetRoundNum}.`,
        });
      }
      const qualified = prevRound.qualifiedTeams || [];
      if (qualified.length < 2) {
        return res.status(400).json({
          error: `Insufficient qualified teams for Round ${targetRoundNum} (Found: ${qualified.length}).`,
        });
      }
      fixtureData = await generateSubsequentRoundFixtures({
        category,
        roundNumber: targetRoundNum,
        qualifiedTeams: qualified,
        availableCourts: courts,
      });
    }

    const roundId = existingSame ? existingSame.id : `rnd-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;

    // If publishing immediately, create Match documents
    let matchIds = [];
    if (publishNow) {
      matchIds = await createAndPersistMatches(fixtureData.fixtures, roundId, category, targetRoundNum);
    }

    // Determine initial qualified teams: Bye recipient automatically qualifies!
    const initialQualified = fixtureData.byeTeam ? [fixtureData.byeTeam] : [];

    let roundDoc;
    if (existingSame) {
      existingSame.roundName = fixtureData.roundName;
      existingSame.totalTeams = fixtureData.totalTeams;
      existingSame.participatingTeams = fixtureData.participatingTeams;
      existingSame.qualifiedTeams = initialQualified;
      existingSame.byeTeam = fixtureData.byeTeam;
      existingSame.pairingExplanation = fixtureData.pairingExplanations;
      existingSame.fixtures = matchIds;
      existingSame.status = publishNow ? "published" : "draft";
      existingSame.publishedAt = publishNow ? new Date() : null;
      existingSame.createdBy = req.admin?.name || "Admin";
      await existingSame.save();
      roundDoc = existingSame;
    } else {
      roundDoc = await Round.create({
        id: roundId,
        tournamentId: "apex-badminton-2026",
        category,
        roundNumber: targetRoundNum,
        roundName: fixtureData.roundName,
        totalTeams: fixtureData.totalTeams,
        participatingTeams: fixtureData.participatingTeams,
        qualifiedTeams: initialQualified,
        byeTeam: fixtureData.byeTeam,
        fixtures: matchIds,
        pairingExplanation: fixtureData.pairingExplanations,
        status: publishNow ? "published" : "draft",
        publishedAt: publishNow ? new Date() : null,
        createdBy: req.admin?.name || "Admin",
      });
    }

    realtime.broadcast("round_update", { category, round: roundDoc });
    return res.status(201).json({ success: true, round: roundDoc });
  } catch (error) {
    console.error("createRound error:", error);
    return res.status(400).json({ error: error.message || "Failed to create round." });
  }
}

/**
 * Publishes an existing draft round, instantiating the Match records.
 */
export async function publishRound(req, res) {
  try {
    const { id } = req.params;
    const roundDoc = await Round.findOne(roundQuery(id));
    if (!roundDoc) return res.status(404).json({ error: "Round not found." });

    if (roundDoc.status === "published") {
      return res.json({ success: true, message: "Round is already published.", round: roundDoc });
    }
    if (roundDoc.status === "completed") {
      return res.status(400).json({ error: "Cannot publish an already completed round." });
    }

    const settings = (await TournamentSettings.findOne({ id: "default" })) || {};
    const courts = settings.number_of_courts || 4;

    // Generate fresh fixtures from participating teams & bye
    const plainParticipants = (roundDoc.participatingTeams || []).map((t) =>
      t && typeof t.toObject === "function" ? t.toObject() : t
    );
    let fixtureData;
    if (roundDoc.roundNumber === 1) {
      fixtureData = generateRound1Fixtures({
        competitors: plainParticipants,
        category: roundDoc.category,
        availableCourts: courts,
      });
    } else {
      fixtureData = await generateSubsequentRoundFixtures({
        category: roundDoc.category,
        roundNumber: roundDoc.roundNumber,
        qualifiedTeams: plainParticipants,
        availableCourts: courts,
      });
    }

    // Persist matches to DB
    const matchIds = await createAndPersistMatches(
      fixtureData.fixtures,
      roundDoc.id,
      roundDoc.category,
      roundDoc.roundNumber
    );

    roundDoc.fixtures = matchIds;
    roundDoc.pairingExplanation = fixtureData.pairingExplanations;
    roundDoc.byeTeam = fixtureData.byeTeam;
    roundDoc.qualifiedTeams = fixtureData.byeTeam ? [fixtureData.byeTeam] : [];
    roundDoc.status = "published";
    roundDoc.publishedAt = new Date();
    await roundDoc.save();

    realtime.broadcast("round_update", { category: roundDoc.category, round: roundDoc });
    return res.json({ success: true, round: roundDoc });
  } catch (error) {
    console.error("publishRound error:", error);
    return res.status(400).json({ error: error.message || "Failed to publish round." });
  }
}

/**
 * Helper to persist match documents to MongoDB Atlas and SQLite cache.
 */
async function createAndPersistMatches(fixtures, roundId, category, roundNumber) {
  const matchIds = [];
  const isDoubles = isDoublesCategory(category);
  const totalMatches = await Match.countDocuments();

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const matchId = `mth-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;

    const initialPosA = isDoubles
      ? { right: f.team_a_player1_id, left: f.team_a_player2_id }
      : { right: f.team_a_player1_id, left: null };
    const initialPosB = isDoubles
      ? { right: f.team_b_player1_id, left: f.team_b_player2_id }
      : { right: f.team_b_player1_id, left: null };

    const matchDoc = await Match.create({
      id: matchId,
      tournamentId: "apex-badminton-2026",
      roundId,
      roundNumber,
      category,
      round: f.round,
      match_number: totalMatches + i + 1,
      court_number: f.court_number || 1,
      scheduled_time: f.scheduled_time || null,
      status: "scheduled",
      team_a_id: f.team_a_id,
      team_a_name: f.team_a_name,
      team_a_player1_id: f.team_a_player1_id,
      team_a_player2_id: f.team_a_player2_id || null,
      score_a: 0,
      team_b_id: f.team_b_id,
      team_b_name: f.team_b_name,
      team_b_player1_id: f.team_b_player1_id,
      team_b_player2_id: f.team_b_player2_id || null,
      score_b: 0,
      serving_team: "A",
      serving_player_id: f.team_a_player1_id,
      receiving_player_id: f.team_b_player1_id,
      service_court: "right",
      team_a_positions: initialPosA,
      team_b_positions: initialPosB,
      court_side_a: "left",
      history: [],
      points_awarded: false,
    });

    syncMatchToSqlite(matchDoc);
    realtime.broadcastMatchUpdate(matchDoc);
    matchIds.push(matchId);
  }

  return matchIds;
}

/**
 * Resets an eligible round.
 * Eligible only if no matches have started or completed.
 */
export async function resetRound(req, res) {
  try {
    const { id } = req.params;
    const roundDoc = await Round.findOne(roundQuery(id));
    if (!roundDoc) return res.status(404).json({ error: "Round not found." });

    // Check if subsequent rounds exist
    const higherRound = await Round.findOne({
      category: roundDoc.category,
      roundNumber: { $gt: roundDoc.roundNumber },
    });
    if (higherRound) {
      return res.status(400).json({
        error: `Cannot reset Round ${roundDoc.roundNumber}: Subsequent rounds already exist. Reset higher rounds first.`,
      });
    }

    // Check if any match in this round is in progress or completed
    if (roundDoc.fixtures && roundDoc.fixtures.length > 0) {
      const activeMatches = await Match.find({
        id: { $in: roundDoc.fixtures },
        status: { $in: ["live", "completed", "paused", "tied"] },
      });

      if (activeMatches.length > 0) {
        return res.status(400).json({
          error: `Cannot reset Round ${roundDoc.roundNumber}: ${activeMatches.length} match(es) have already started or concluded.`,
        });
      }

      // Delete scheduled matches
      await Match.deleteMany({ id: { $in: roundDoc.fixtures } });
    }

    // Delete the round
    await Round.deleteOne({ _id: roundDoc._id });
    realtime.broadcast("round_deleted", { id: roundDoc.id, category: roundDoc.category });

    return res.json({ success: true, message: `Round ${roundDoc.roundNumber} reset successfully.` });
  } catch (error) {
    console.error("resetRound error:", error);
    return res.status(400).json({ error: error.message || "Failed to reset round." });
  }
}

/**
 * Monitors and updates a round's completion status.
 * Called automatically when a match completes or manually via API.
 */
export async function checkAndUpdateRoundStatus(roundIdentifier) {
  try {
    const roundDoc = await Round.findOne(roundQuery(roundIdentifier));
    if (!roundDoc) return null;
    if (roundDoc.status === "completed") return roundDoc;
    if (!roundDoc.fixtures || roundDoc.fixtures.length === 0) return roundDoc;

    const matches = await Match.find({ id: { $in: roundDoc.fixtures } });
    if (matches.length === 0) return roundDoc;

    const allCompleted = matches.every(
      (m) => m.status === "completed" && (m.winner_team === "A" || m.winner_team === "B")
    );

    if (allCompleted) {
      const qualified = [];

      // 1. Add Bye team if present
      if (roundDoc.byeTeam && roundDoc.byeTeam.id) {
        const plainBye =
          typeof roundDoc.byeTeam.toObject === "function"
            ? roundDoc.byeTeam.toObject()
            : roundDoc.byeTeam;
        qualified.push({
          ...plainBye,
          advancementReason: "bye",
        });
      }

      // 2. Add Match winners
      for (const m of matches) {
        const isWinnerA = m.winner_team === "A";
        const winnerId = isWinnerA ? (m.team_a_id || m.team_a_player1_id) : (m.team_b_id || m.team_b_player1_id);
        const winnerName = isWinnerA ? m.team_a_name : m.team_b_name;
        const winnerP1 = isWinnerA ? m.team_a_player1_id : m.team_b_player1_id;
        const winnerP2 = isWinnerA ? m.team_a_player2_id : m.team_b_player2_id;
        const isDoubles = isDoublesCategory(m.category);

        qualified.push({
          id: winnerId,
          name: winnerName,
          type: isDoubles ? "team" : "player",
          player1_id: winnerP1,
          player2_id: winnerP2 || null,
          category: m.category,
          advancementReason: "winner",
        });
      }

      // Deduplicate qualified teams by ID
      const uniqueQualified = [];
      const seen = new Set();
      for (const q of qualified) {
        if (!seen.has(q.id)) {
          seen.add(q.id);
          uniqueQualified.push(q);
        }
      }

      roundDoc.qualifiedTeams = uniqueQualified;
      roundDoc.status = "completed";
      roundDoc.completedAt = new Date();
      await roundDoc.save();

      realtime.broadcast("round_update", { category: roundDoc.category, round: roundDoc });
    }

    return roundDoc;
  } catch (err) {
    console.error("checkAndUpdateRoundStatus error:", err);
    return null;
  }
}

/**
 * Returns comprehensive category tournament overview.
 */
export async function getCategoryOverview(req, res) {
  try {
    const { category } = req.params;
    const competitors = await getRegisteredCompetitors(category);
    const rounds = await Round.find({ category }).sort({ roundNumber: 1 });

    // Check completion status for active rounds
    for (const r of rounds) {
      if (r.status === "published") {
        await checkAndUpdateRoundStatus(r.id);
      }
    }

    // Re-fetch updated rounds
    const updatedRounds = await Round.find({ category }).sort({ roundNumber: 1 });

    // Fetch all matches for these rounds
    const allFixtureIds = updatedRounds.flatMap((r) => r.fixtures || []);
    const matches = await Match.find({ id: { $in: allFixtureIds } }).sort({
      roundNumber: 1,
      match_number: 1,
    });

    const activeRound = updatedRounds.find((r) => r.status === "published") ||
      updatedRounds.find((r) => r.status === "draft") ||
      updatedRounds[updatedRounds.length - 1] || null;

    // Check if next round can be created
    let canCreateNextRound = false;
    let nextRoundPrompt = "";

    if (updatedRounds.length === 0) {
      canCreateNextRound = competitors.length >= 2;
      nextRoundPrompt = canCreateNextRound
        ? "Ready to generate Round 1 draw."
        : "At least 2 competitors required to begin.";
    } else {
      const latestRound = updatedRounds[updatedRounds.length - 1];
      if (latestRound.status === "draft") {
        canCreateNextRound = false;
        nextRoundPrompt = `Round ${latestRound.roundNumber} is currently in draft. Review and publish first.`;
      } else if (latestRound.status === "published") {
        const roundMatches = matches.filter((m) => latestRound.fixtures.includes(m.id));
        const pending = roundMatches.filter((m) => m.status !== "completed");
        if (pending.length > 0) {
          canCreateNextRound = false;
          nextRoundPrompt = `Round ${latestRound.roundNumber} has ${pending.length} pending match(es). All matches must be completed first.`;
        } else {
          // If 2 teams played in this round and it was the Final, tournament is over!
          if (latestRound.roundName === "Final" || latestRound.totalTeams === 2) {
            canCreateNextRound = false;
            nextRoundPrompt = "Tournament completed! Category champion decided.";
          } else {
            canCreateNextRound = true;
            nextRoundPrompt = `Round ${latestRound.roundNumber} completed! Ready to create Round ${latestRound.roundNumber + 1}.`;
          }
        }
      } else if (latestRound.status === "completed") {
        if (latestRound.roundName === "Final" || latestRound.totalTeams === 2) {
          canCreateNextRound = false;
          nextRoundPrompt = "Tournament completed! Category champion decided.";
        } else {
          canCreateNextRound = true;
          nextRoundPrompt = `Ready to generate Round ${latestRound.roundNumber + 1} from qualified teams.`;
        }
      }
    }

    // Determine Champion if Final is completed
    let champion = null;
    const finalRound = updatedRounds.find((r) => r.roundName === "Final" && r.status === "completed");
    if (finalRound && finalRound.fixtures.length > 0) {
      const finalMatch = matches.find((m) => finalRound.fixtures.includes(m.id));
      if (finalMatch && finalMatch.status === "completed" && finalMatch.winner_name) {
        champion = {
          name: finalMatch.winner_name,
          teamId: finalMatch.winner_team === "A" ? finalMatch.team_a_id : finalMatch.team_b_id,
          finalScore: `${finalMatch.score_a} - ${finalMatch.score_b}`,
        };
      }
    }

    // Compute category standings
    const standings = await computeCategoryStandings(category);

    return res.json({
      success: true,
      category,
      totalRegisteredCompetitors: competitors.length,
      competitors,
      rounds: updatedRounds,
      activeRound,
      matches,
      canCreateNextRound,
      nextRoundPrompt,
      champion,
      standings,
    });
  } catch (error) {
    console.error("getCategoryOverview error:", error);
    return res.status(500).json({ error: "Failed to fetch category overview." });
  }
}

/**
 * Returns knockout bracket data for public & admin views.
 */
export async function getCategoryBracket(req, res) {
  try {
    const { category } = req.params;
    const rounds = await Round.find({ category }).sort({ roundNumber: 1 });
    const allFixtureIds = rounds.flatMap((r) => r.fixtures || []);
    const matches = await Match.find({ id: { $in: allFixtureIds } });

    // Champion check
    let champion = null;
    const finalRound = rounds.find((r) => r.roundName === "Final" && r.status === "completed");
    if (finalRound && finalRound.fixtures.length > 0) {
      const finalMatch = matches.find((m) => finalRound.fixtures.includes(m.id));
      if (finalMatch && finalMatch.status === "completed" && finalMatch.winner_name) {
        champion = {
          name: finalMatch.winner_name,
          winnerTeam: finalMatch.winner_team,
          finalScore: `${finalMatch.score_a} - ${finalMatch.score_b}`,
          category,
        };
      }
    }

    const bracketRounds = rounds.map((r) => {
      const roundMatches = matches.filter((m) => (r.fixtures || []).includes(m.id));
      return {
        id: r.id,
        roundNumber: r.roundNumber,
        roundName: r.roundName,
        status: r.status,
        totalTeams: r.totalTeams,
        byeTeam: r.byeTeam,
        qualifiedTeams: r.qualifiedTeams,
        matches: roundMatches,
      };
    });

    return res.json({
      success: true,
      category,
      rounds: bracketRounds,
      champion,
    });
  } catch (error) {
    console.error("getCategoryBracket error:", error);
    return res.status(500).json({ error: "Failed to fetch category bracket." });
  }
}

/**
 * Category standings with optional round filter
 */
export async function getStandings(req, res) {
  try {
    const { category } = req.params;
    const { roundNumber } = req.query;

    const roundNumFilter = roundNumber && roundNumber !== "all" ? Number(roundNumber) : null;
    const standings = await computeCategoryStandings(category, roundNumFilter);

    return res.json({ success: true, category, standings, roundFiltered: roundNumFilter });
  } catch (error) {
    console.error("getStandings error:", error);
    return res.status(500).json({ error: "Failed to calculate standings." });
  }
}

/**
 * List rounds
 */
export async function getRounds(req, res) {
  try {
    const { category } = req.query;
    const filter = {};
    if (category) filter.category = category;

    const rounds = await Round.find(filter).sort({ category: 1, roundNumber: 1 });
    return res.json({ success: true, rounds });
  } catch (error) {
    console.error("getRounds error:", error);
    return res.status(500).json({ error: "Failed to fetch rounds." });
  }
}

/**
 * Get specific round with populated matches
 */
export async function getRound(req, res) {
  try {
    const { id } = req.params;
    const roundDoc = await Round.findOne(roundQuery(id));
    if (!roundDoc) return res.status(404).json({ error: "Round not found." });

    const matches = await Match.find({ id: { $in: roundDoc.fixtures || [] } }).sort({ match_number: 1 });
    return res.json({ success: true, round: roundDoc, matches });
  } catch (error) {
    console.error("getRound error:", error);
    return res.status(500).json({ error: "Failed to fetch round." });
  }
}
