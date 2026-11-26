import Match from "../models/Match.js";
import Player from "../models/Player.js";
import Team from "../models/Team.js";
import TournamentSettings from "../models/TournamentSettings.js";
import TournamentPoint from "../models/TournamentPoint.js";
import PointHistory from "../models/PointHistory.js";
import mongoose from "mongoose";
import { deleteMatchFromSqlite, syncMatchToSqlite, getSqliteDb } from "../services/sqliteSync.js";
import {
  initializeMatchState,
  scorePoint as calcScorePoint,
  undoLastPoint as calcUndoPoint,
  recordLet as calcRecordLet,
  isDoublesCategory,
} from "../services/scoringEngine.js";
import { realtime } from "../services/realtimeService.js";
import { checkAndUpdateRoundStatus } from "./roundController.js";

async function enrichMatch(matchDoc) {
  if (!matchDoc) return null;
  const match = matchDoc.toObject ? matchDoc.toObject() : matchDoc;

  const [p1A, p2A, p1B, p2B] = await Promise.all([
    match.team_a_player1_id ? Player.findOne({ id: match.team_a_player1_id }) : null,
    match.team_a_player2_id ? Player.findOne({ id: match.team_a_player2_id }) : null,
    match.team_b_player1_id ? Player.findOne({ id: match.team_b_player1_id }) : null,
    match.team_b_player2_id ? Player.findOne({ id: match.team_b_player2_id }) : null,
  ]);

  return {
    ...match,
    team_a_player1: p1A,
    team_a_player2: p2A,
    team_b_player1: p1B,
    team_b_player2: p2B,
  };
}

export async function findOrImportMatch(id) {
  let match = await Match.findOne({ id });
  if (match) return match;

  // Fallback: Check if match exists in local SQLite database and import it into MongoDB Atlas
  try {
    const db = getSqliteDb();
    if (db) {
      const row = db.prepare("SELECT * FROM matches WHERE id = ?").get(id);
      if (row) {
        match = await Match.create({
          id: row.id,
          category: row.category,
          round: row.round || "Round of 16",
          match_number: row.match_number || 1,
          court_number: row.court_number || 1,
          scheduled_time: row.scheduled_time || null,
          status: row.status || "scheduled",
          team_a_id: row.team_a_id || null,
          team_a_name: row.team_a_name,
          team_a_player1_id: row.team_a_player1_id,
          team_a_player2_id: row.team_a_player2_id || null,
          score_a: row.score_a || 0,
          team_b_id: row.team_b_id || null,
          team_b_name: row.team_b_name,
          team_b_player1_id: row.team_b_player1_id,
          team_b_player2_id: row.team_b_player2_id || null,
          score_b: row.score_b || 0,
          serving_team: row.serving_team || "A",
          serving_player_id: row.serving_player_id || row.team_a_player1_id,
          receiving_player_id: row.receiving_player_id || row.team_b_player1_id,
          service_court: row.service_court || "right",
          team_a_positions: row.team_a_positions ? JSON.parse(row.team_a_positions) : {},
          team_b_positions: row.team_b_positions ? JSON.parse(row.team_b_positions) : {},
          court_side_a: row.court_side_a || "left",
          toss_winner: row.toss_winner || null,
          toss_choice: row.toss_choice || null,
          winner_team: row.winner_team || null,
          winner_name: row.winner_name || null,
          next_match_id: row.next_match_id || null,
          next_match_slot: row.next_match_slot || null,
          history: row.history ? JSON.parse(row.history) : [],
          started_at: row.started_at ? new Date(row.started_at) : null,
          completed_at: row.completed_at ? new Date(row.completed_at) : null,
          timer_duration_seconds: row.timer_duration_seconds || 0,
          timer_enabled: row.timer_enabled || 0,
          timer_status: row.timer_status || "stopped",
          timer_start_ts: row.timer_start_ts ? new Date(row.timer_start_ts) : null,
          timer_paused_at: row.timer_paused_at ? new Date(row.timer_paused_at) : null,
          timer_remaining_seconds: row.timer_remaining_seconds || 0,
          timer_mode: row.timer_mode || "COUNTDOWN",
          sudden_death_start_ts: row.sudden_death_start_ts ? new Date(row.sudden_death_start_ts) : null,
          is_sudden_death: Boolean(row.is_sudden_death),
          completion_reason: row.completion_reason || null,
        });
        console.log(`[Auto-Import] Successfully imported match ${id} into MongoDB Atlas.`);
      }
    }
  } catch (err) {
    console.error("[Auto-Import] Fallback check failed:", err.message);
  }

  return match;
}

export async function getMatches(req, res) {
  try {
    const { status, category, court } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (category) filter.category = category;
    if (court) filter.court_number = Number(court);

    let matches = await Match.find(filter).sort({
      court_number: 1,
      match_number: 1,
      created_at: 1,
    });

    if (matches.length === 0) {
      try {
        const db = getSqliteDb();
        if (db) {
          const rows = db.prepare("SELECT id FROM matches").all();
          for (const r of rows) {
            await findOrImportMatch(r.id);
          }
          matches = await Match.find(filter).sort({
            court_number: 1,
            match_number: 1,
            created_at: 1,
          });
        }
      } catch (_) { }
    }

    const enriched = await Promise.all(matches.map(enrichMatch));
    return res.json({ matches: enriched });
  } catch (error) {
    console.error("GetMatches error:", error);
    return res.status(500).json({ error: "Failed to fetch matches." });
  }
}

export async function getMatch(req, res) {
  try {
    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });
    const enriched = await enrichMatch(match);
    return res.json({ match: enriched });
  } catch (error) {
    console.error("GetMatch error:", error);
    return res.status(500).json({ error: "Failed to fetch match." });
  }
}

export async function createMatch(req, res) {
  try {
    const data = req.body;
    const total = await Match.countDocuments();
    const matchNumber = data.match_number || total + 1;
    const id = `mth-${Date.now().toString(36)}`;

    const timerEnabled = data.timer_enabled ? 1 : 0;
    const timerDuration = timerEnabled ? Number(data.timer_duration_seconds) || 0 : 0;

    const isDoubles = isDoublesCategory(data.category);
    const initialPosA = isDoubles
      ? { right: data.team_a_player1_id, left: data.team_a_player2_id }
      : { right: data.team_a_player1_id, left: null };
    const initialPosB = isDoubles
      ? { right: data.team_b_player1_id, left: data.team_b_player2_id }
      : { right: data.team_b_player1_id, left: null };

    const match = await Match.create({
      id,
      category: data.category,
      round: data.round || "Round of 16",
      match_number: matchNumber,
      court_number: Number(data.court_number || 1),
      scheduled_time: data.scheduled_time || null,
      status: "scheduled",
      team_a_id: data.team_a_id || null,
      team_a_name: data.team_a_name,
      team_a_player1_id: data.team_a_player1_id,
      team_a_player2_id: data.team_a_player2_id || null,
      score_a: 0,
      team_b_id: data.team_b_id || null,
      team_b_name: data.team_b_name,
      team_b_player1_id: data.team_b_player1_id,
      team_b_player2_id: data.team_b_player2_id || null,
      score_b: 0,
      serving_team: "A",
      serving_player_id: data.team_a_player1_id,
      receiving_player_id: data.team_b_player1_id,
      service_court: "right",
      team_a_positions: initialPosA,
      team_b_positions: initialPosB,
      court_side_a: "left",
      next_match_id: data.next_match_id || null,
      next_match_slot: data.next_match_slot || null,
      timer_enabled: timerEnabled,
      timer_duration_seconds: timerDuration,
      timer_remaining_seconds: timerDuration,
      timer_status: "stopped",
      history: [],
    });

    const enriched = await enrichMatch(match);
    syncMatchToSqlite(match);
    realtime.broadcastMatchUpdate(enriched);
    return res.status(201).json({ success: true, match: enriched });
  } catch (error) {
    console.error("CreateMatch error:", error);
    return res.status(400).json({ error: error.message || "Failed to create match." });
  }
}

export async function updateMatch(req, res) {
  try {
    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });

    Object.assign(match, req.body);
    match.updated_at = new Date();
    await match.save();

    syncMatchToSqlite(match);
    const enriched = await enrichMatch(match);
    realtime.broadcastMatchUpdate(enriched);
    return res.json({ success: true, match: enriched });
  } catch (error) {
    console.error("UpdateMatch error:", error);
    return res.status(400).json({ error: error.message || "Failed to update match." });
  }
}

async function revertMatchPoints(matchDoc, adminName = "Admin", reason = "Match Deleted - Points Reverted") {
  if (!matchDoc || !matchDoc.points_awarded) return;

  let settings = await TournamentSettings.findOne({ id: "default" });
  if (!settings) settings = { points_per_win: 3, points_per_participation: 1 };

  const winPoints = settings.points_per_win ?? 3;
  const partPoints = settings.points_per_participation ?? 1;
  const isWinnerA = matchDoc.winner_team === "A";
  const isDoubles = isDoublesCategory(matchDoc.category);

  const pointsA = (isWinnerA ? winPoints : 0) + partPoints;
  const pointsB = (!isWinnerA ? winPoints : 0) + partPoints;

  await revertParticipantPoints(
    isDoubles ? "team" : "player",
    matchDoc.team_a_id || matchDoc.team_a_player1_id,
    matchDoc.team_a_name,
    matchDoc.category,
    isWinnerA,
    matchDoc.score_a || 0,
    matchDoc.score_b || 0,
    pointsA,
    adminName,
    reason
  );

  await revertParticipantPoints(
    isDoubles ? "team" : "player",
    matchDoc.team_b_id || matchDoc.team_b_player1_id,
    matchDoc.team_b_name,
    matchDoc.category,
    !isWinnerA,
    matchDoc.score_b || 0,
    matchDoc.score_a || 0,
    pointsB,
    adminName,
    reason
  );
}

async function revertParticipantPoints(entityType, entityId, entityName, category, won, scored, conceded, ptsAwarded, adminName = "Admin", reason = "Match Deleted - Points Reverted") {
  if (!entityId) return;
  const record = await TournamentPoint.findOne({ entity_id: entityId, category });
  if (record) {
    record.matches_played = Math.max(0, (record.matches_played || 0) - 1);
    if (won) {
      record.matches_won = Math.max(0, (record.matches_won || 0) - 1);
    } else {
      record.matches_lost = Math.max(0, (record.matches_lost || 0) - 1);
    }
    record.points_scored = Math.max(0, (record.points_scored || 0) - (scored || 0));
    record.points_conceded = Math.max(0, (record.points_conceded || 0) - (conceded || 0));
    record.total_tournament_points = (record.total_tournament_points || 0) - (ptsAwarded || 0);

    if (
      record.matches_played <= 0 &&
      record.total_tournament_points <= 0 &&
      record.points_scored <= 0 &&
      record.points_conceded <= 0
    ) {
      await TournamentPoint.deleteOne({ _id: record._id });
    } else {
      record.win_rate =
        record.matches_played > 0
          ? Math.round((record.matches_won / record.matches_played) * 100)
          : 0;
      record.updated_at = new Date();
      await record.save();
    }
  }

  const logId = `log-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
  await PointHistory.create({
    id: logId,
    entity_type: entityType,
    entity_id: entityId,
    entity_name: entityName || entityId,
    category,
    points_delta: -(ptsAwarded || 0),
    reason,
    adjusted_by: adminName,
  });
}

export async function deleteMatch(req, res) {
  try {
    const rawId = req.params.id;
    const isObjId = mongoose.isValidObjectId(rawId);
    const query = {
      $or: [
        { id: rawId },
        ...(isObjId ? [{ _id: rawId }] : []),
      ],
    };

    const matchToDelete = await Match.findOne(query);

    // 1. Delete from MongoDB Atlas
    await Match.deleteMany(query);

    // 2. Delete synchronously from local SQLite database (localhost)
    deleteMatchFromSqlite(rawId);

    // 3. Revert leaderboard & participant stats if this was a completed match
    if (matchToDelete && matchToDelete.status === "completed" && matchToDelete.points_awarded) {
      await revertMatchPoints(
        matchToDelete,
        req.admin?.name || "Admin",
        "Match Deleted - Points Reverted"
      );
      await syncAllParticipantStats();
      realtime.broadcastPointsUpdate();
    }

    if (matchToDelete?.roundId) {
      await checkAndUpdateRoundStatus(matchToDelete.roundId);
    }

    // 4. Broadcast realtime update
    realtime.broadcast("match_update", { id: rawId, deleted: true });

    return res.json({ success: true, message: "Match deleted from database and local storage." });
  } catch (error) {
    console.error("DeleteMatch error:", error);
    return res.status(500).json({ error: "Failed to delete match." });
  }
}

export async function updateStatus(req, res) {
  try {
    const { status, toss } = req.body;
    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });

    // Handle Toss Start
    if (status === "live" && toss) {
      // Validate overlapping players in live matches
      const activePlayers = [
        match.team_a_player1_id,
        match.team_a_player2_id,
        match.team_b_player1_id,
        match.team_b_player2_id,
      ].filter(Boolean);

      const liveMatches = await Match.find({ status: "live", id: { $ne: match.id } });
      for (const lm of liveMatches) {
        const lmPlayers = [
          lm.team_a_player1_id,
          lm.team_a_player2_id,
          lm.team_b_player1_id,
          lm.team_b_player2_id,
        ].filter(Boolean);
        const overlap = activePlayers.some((p) => lmPlayers.includes(p));
        if (overlap) {
          return res.status(400).json({
            error: `Cannot start match: One of the players is already active in a live match on Court ${lm.court_number}.`,
          });
        }
      }

      const enriched = await enrichMatch(match);
      const teamAPlayers = [enriched.team_a_player1, enriched.team_a_player2].filter(Boolean);
      const teamBPlayers = [enriched.team_b_player1, enriched.team_b_player2].filter(Boolean);

      const initState = initializeMatchState({
        category: match.category,
        teamAPlayers,
        teamBPlayers,
        tossWinner: toss.tossWinner || "A",
        tossChoice: toss.tossChoice || "serve",
        courtSideA: toss.courtSideA || "left",
        initialServerId: toss.initialServerId || null,
        initialReceiverId: toss.initialReceiverId || null,
      });

      match.status = "live";
      match.score_a = 0;
      match.score_b = 0;
      match.serving_team = initState.servingTeam;
      match.serving_player_id = initState.servingPlayerId;
      match.receiving_player_id = initState.receivingPlayerId;
      match.service_court = initState.serviceCourt;
      match.team_a_positions = initState.teamAPositions;
      match.team_b_positions = initState.teamBPositions;
      match.court_side_a = initState.courtSideA;
      match.toss_winner = toss.tossWinner || "A";
      match.toss_choice = toss.tossChoice || "serve";
      match.winner_team = null;
      match.winner_name = null;
      match.started_at = new Date();
      match.history = [];
      match.timer_mode = "COUNTDOWN";
      match.is_sudden_death = false;
      match.sudden_death_start_ts = null;

      // Keep timer stopped upon toss setup until umpire explicitly starts it or first rally is played
      if (match.timer_enabled) {
        match.timer_status = "stopped";
        match.timer_start_ts = null;
        match.timer_remaining_seconds = match.timer_duration_seconds;
      }

      await match.save();
      syncMatchToSqlite(match);

      const updatedEnriched = await enrichMatch(match);
      realtime.broadcastMatchUpdate(updatedEnriched);
      return res.json({ success: true, match: updatedEnriched });
    }

    // Manual status update
    if (status === "completed" && !match.winner_team) {
      match.winner_team = match.score_a > match.score_b ? "A" : "B";
      match.winner_name = match.winner_team === "A" ? match.team_a_name : match.team_b_name;
      match.completed_at = new Date();
      match.timer_status = "stopped";
      await handleMatchCompletion(match, match.winner_team, match.winner_name, match.score_a, match.score_b);
    }

    match.status = status;
    match.updated_at = new Date();
    await match.save();

    syncMatchToSqlite(match);
    const updatedEnriched = await enrichMatch(match);
    realtime.broadcastMatchUpdate(updatedEnriched);
    return res.json({ success: true, match: updatedEnriched });
  } catch (error) {
    console.error("UpdateStatus error:", error);
    return res.status(400).json({ error: error.message || "Failed to update match status." });
  }
}

export async function scoreMatchPoint(req, res) {
  try {
    const { winningTeam, faultReason } = req.body;
    if (!winningTeam || (winningTeam !== "A" && winningTeam !== "B")) {
      return res.status(400).json({ error: "Invalid winning team. Must be 'A' or 'B'." });
    }
    if (!faultReason) {
      return res.status(400).json({ error: "Fault reason is required before awarding point." });
    }

    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });
    if (match.status !== "live") return res.status(400).json({ error: "Match is not live." });

    const enriched = await enrichMatch(match);
    const teamAPlayers = [enriched.team_a_player1, enriched.team_a_player2].filter(Boolean);
    const teamBPlayers = [enriched.team_b_player1, enriched.team_b_player2].filter(Boolean);

    const currentState = {
      scoreA: match.score_a,
      scoreB: match.score_b,
      servingTeam: match.serving_team,
      servingPlayerId: match.serving_player_id,
      receivingPlayerId: match.receiving_player_id,
      serviceCourt: match.service_court,
      teamAPositions: match.team_a_positions,
      teamBPositions: match.team_b_positions,
      courtSideA: match.court_side_a,
      isGameOver: false,
      winner: null,
      history: match.history || [],
    };

    const nextState = calcScorePoint(currentState, winningTeam, match.category, teamAPlayers, teamBPlayers, faultReason);

    // Annotate last history snapshot with fault reason
    if (nextState.history && nextState.history.length > 0) {
      nextState.history[nextState.history.length - 1].faultReason = faultReason;
    }

    match.score_a = nextState.scoreA;
    match.score_b = nextState.scoreB;
    match.serving_team = nextState.servingTeam;
    match.serving_player_id = nextState.servingPlayerId;
    match.receiving_player_id = nextState.receivingPlayerId;
    match.service_court = nextState.serviceCourt;
    match.team_a_positions = nextState.teamAPositions;
    match.team_b_positions = nextState.teamBPositions;
    match.history = nextState.history;

    const isSuddenDeath = match.timer_mode === "SUDDEN_DEATH" || Boolean(match.is_sudden_death);

    if (isSuddenDeath) {
      // In Sudden Death: The very first valid point awarded immediately wins the match!
      // Normal 11-point and 15-point winning conditions are suspended.
      match.status = "completed";
      match.winner_team = winningTeam;
      match.winner_name = winningTeam === "A" ? match.team_a_name : match.team_b_name;
      match.completed_at = new Date();
      match.timer_status = "stopped";
      match.completion_reason = "SUDDEN_DEATH";
      await handleMatchCompletion(match, match.winner_team, match.winner_name, nextState.scoreA, nextState.scoreB);
    } else if (nextState.isGameOver) {
      match.status = "completed";
      match.winner_team = nextState.winner;
      match.winner_name = nextState.winner === "A" ? match.team_a_name : match.team_b_name;
      match.completed_at = new Date();
      match.timer_status = "stopped";
      match.completion_reason = "NORMAL_SCORING";
      await handleMatchCompletion(match, match.winner_team, match.winner_name, nextState.scoreA, nextState.scoreB);
    } else if (match.timer_enabled && match.timer_status === "stopped") {
      // Auto-start timer on the first scored rally point if umpire hasn't manually started it yet
      match.timer_status = "running";
      match.timer_start_ts = new Date();
      match.timer_remaining_seconds = match.timer_duration_seconds;
    }

    match.updated_at = new Date();
    await match.save();

    syncMatchToSqlite(match);
    const updatedEnriched = await enrichMatch(match);
    realtime.broadcastMatchUpdate(updatedEnriched);
    return res.json({ success: true, match: updatedEnriched });
  } catch (error) {
    console.error("ScorePoint error:", error);
    return res.status(400).json({ error: error.message || "Failed to score point." });
  }
}

export async function undoPoint(req, res) {
  try {
    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });

    const currentState = {
      scoreA: match.score_a,
      scoreB: match.score_b,
      servingTeam: match.serving_team,
      servingPlayerId: match.serving_player_id,
      receivingPlayerId: match.receiving_player_id,
      serviceCourt: match.service_court,
      teamAPositions: match.team_a_positions,
      teamBPositions: match.team_b_positions,
      courtSideA: match.court_side_a,
      isGameOver: match.status === "completed",
      winner: match.winner_team,
      history: match.history || [],
    };

    const wasCompleted = match.status === "completed";
    const undoneState = calcUndoPoint(currentState);

    match.score_a = undoneState.scoreA;
    match.score_b = undoneState.scoreB;
    match.serving_team = undoneState.servingTeam;
    match.serving_player_id = undoneState.servingPlayerId;
    match.receiving_player_id = undoneState.receivingPlayerId;
    match.service_court = undoneState.serviceCourt;
    match.team_a_positions = undoneState.teamAPositions;
    match.team_b_positions = undoneState.teamBPositions;
    match.history = undoneState.history;

    const isSuddenDeath = match.timer_mode === "SUDDEN_DEATH" || Boolean(match.is_sudden_death);

    if (isSuddenDeath) {
      match.status = "live";
      match.winner_team = null;
      match.winner_name = null;
      match.completed_at = null;
      match.completion_reason = null;
      match.timer_status = "running";
    } else {
      match.status = undoneState.isGameOver ? "completed" : "live";
      match.winner_team = undoneState.winner;
      match.winner_name = undoneState.winner ? (undoneState.winner === "A" ? match.team_a_name : match.team_b_name) : null;
      if (!undoneState.winner) {
        match.completed_at = null;
        match.completion_reason = null;
      }
    }

    if (wasCompleted && match.status !== "completed" && match.points_awarded) {
      await revertMatchPoints(
        match,
        req.admin?.name || "Admin",
        "Match Point Undone - Points Reverted"
      );
      match.points_awarded = false;
      await syncAllParticipantStats();
      realtime.broadcastPointsUpdate();
    }

    match.updated_at = new Date();
    await match.save();

    syncMatchToSqlite(match);
    const updatedEnriched = await enrichMatch(match);
    realtime.broadcastMatchUpdate(updatedEnriched);
    return res.json({ success: true, match: updatedEnriched });
  } catch (error) {
    console.error("UndoPoint error:", error);
    return res.status(400).json({ error: error.message || "Failed to undo point." });
  }
}

export async function recordMatchLet(req, res) {
  try {
    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });

    const currentState = {
      scoreA: match.score_a,
      scoreB: match.score_b,
      servingTeam: match.serving_team,
      servingPlayerId: match.serving_player_id,
      receivingPlayerId: match.receiving_player_id,
      serviceCourt: match.service_court,
      teamAPositions: match.team_a_positions,
      teamBPositions: match.team_b_positions,
      courtSideA: match.court_side_a,
      isGameOver: match.status === "completed",
      winner: match.winner_team,
      history: match.history || [],
    };

    const letState = calcRecordLet(currentState);
    match.history = letState.history;
    match.updated_at = new Date();
    await match.save();

    syncMatchToSqlite(match);
    const updatedEnriched = await enrichMatch(match);
    realtime.broadcastMatchUpdate(updatedEnriched);
    return res.json({ success: true, match: updatedEnriched });
  } catch (error) {
    console.error("RecordLet error:", error);
    return res.status(400).json({ error: error.message || "Failed to record let." });
  }
}

export async function handleTimerAction(req, res) {
  try {
    const { action } = req.body;
    const match = await findOrImportMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found." });

    const now = Date.now();

    if (action === "check") {
      if (match.status === "completed" || match.timer_status !== "running") {
        const enriched = await enrichMatch(match);
        return res.json({ success: true, match: enriched });
      }

      // If already in sudden death, check action does not stop or decrement countdown
      if (match.timer_mode === "SUDDEN_DEATH" || Boolean(match.is_sudden_death)) {
        const enriched = await enrichMatch(match);
        return res.json({ success: true, match: enriched });
      }

      const startTs = match.timer_start_ts ? new Date(match.timer_start_ts).getTime() : now;
      const elapsed = Math.floor((now - startTs) / 1000);
      const baseRemaining =
        match.timer_remaining_seconds !== null && match.timer_remaining_seconds !== undefined
          ? match.timer_remaining_seconds
          : match.timer_duration_seconds;
      const remaining = Math.max(baseRemaining - elapsed, 0);

      match.timer_remaining_seconds = remaining;

      if (remaining === 0) {
        if (match.score_a === match.score_b) {
          // Scenario B: Scores are tied when time expires -> Enter SUDDEN DEATH!
          match.status = "live";
          match.timer_mode = "SUDDEN_DEATH";
          match.is_sudden_death = true;
          if (!match.sudden_death_start_ts) {
            match.sudden_death_start_ts = new Date();
          }
          match.timer_remaining_seconds = 0;
          match.timer_status = "running";
          match.winner_team = null;
          match.winner_name = null;
          match.completed_at = null;
          match.completion_reason = null;
        } else {
          // Scenario A: A team is leading when time expires -> Leading team wins automatically!
          const winnerTeam = match.score_a > match.score_b ? "A" : "B";
          const winnerName = winnerTeam === "A" ? match.team_a_name : match.team_b_name;
          const completedAt = (match.started_at && match.timer_duration_seconds > 0)
            ? new Date(new Date(match.started_at).getTime() + match.timer_duration_seconds * 1000)
            : new Date();

          match.status = "completed";
          match.winner_team = winnerTeam;
          match.winner_name = winnerName;
          match.completed_at = completedAt;
          match.completion_reason = "TIME_EXPIRED_HIGHER_SCORE";
          match.timer_status = "stopped";
          match.timer_remaining_seconds = 0;

          await handleMatchCompletion(match, winnerTeam, winnerName, match.score_a, match.score_b);
        }
      }

      match.updated_at = new Date();
      await match.save();

      syncMatchToSqlite(match);
      const updatedEnriched = await enrichMatch(match);
      realtime.broadcastMatchUpdate(updatedEnriched);
      return res.json({ success: true, match: updatedEnriched });
    }

    if (action === "pause") {
      const startTs = match.timer_start_ts ? new Date(match.timer_start_ts).getTime() : now;
      const elapsed = Math.floor((now - startTs) / 1000);
      const baseRemaining =
        match.timer_remaining_seconds !== null && match.timer_remaining_seconds !== undefined
          ? match.timer_remaining_seconds
          : match.timer_duration_seconds;
      const remaining = Math.max(baseRemaining - elapsed, 0);

      match.timer_status = "paused";
      match.timer_remaining_seconds = remaining;
      match.timer_start_ts = null;
      match.timer_paused_at = new Date();
      match.updated_at = new Date();
      await match.save();

      syncMatchToSqlite(match);
      const updatedEnriched = await enrichMatch(match);
      realtime.broadcastMatchUpdate(updatedEnriched);
      return res.json({ success: true, match: updatedEnriched });
    }

    if (action === "resume" || action === "start") {
      match.timer_status = "running";
      match.timer_start_ts = new Date();
      match.timer_paused_at = null;
      if (!match.timer_remaining_seconds || match.timer_remaining_seconds <= 0) {
        match.timer_remaining_seconds = match.timer_duration_seconds;
      }
      match.updated_at = new Date();
      await match.save();

      syncMatchToSqlite(match);
      const updatedEnriched = await enrichMatch(match);
      realtime.broadcastMatchUpdate(updatedEnriched);
      return res.json({ success: true, match: updatedEnriched });
    }

    if (action === "reset") {
      match.timer_status = "stopped";
      match.timer_remaining_seconds = match.timer_duration_seconds;
      match.timer_start_ts = null;
      match.timer_paused_at = null;
      match.timer_mode = "COUNTDOWN";
      match.is_sudden_death = false;
      match.sudden_death_start_ts = null;
      match.updated_at = new Date();
      await match.save();

      syncMatchToSqlite(match);
      const updatedEnriched = await enrichMatch(match);
      realtime.broadcastMatchUpdate(updatedEnriched);
      return res.json({ success: true, match: updatedEnriched });
    }

    return res.status(400).json({ error: "Invalid timer action." });
  } catch (error) {
    console.error("Timer action error:", error);
    return res.status(400).json({ error: error.message || "Failed to execute timer action." });
  }
}

async function handleMatchCompletion(match, winnerTeam, winnerName, scoreA, scoreB) {
  // Record official winner and loser
  const isWinnerA = winnerTeam === "A";
  match.winner_team = winnerTeam;
  match.winner_name = winnerName;
  match.loser_team = isWinnerA ? "B" : "A";
  match.loser_name = isWinnerA ? match.team_b_name : match.team_a_name;
  match.loser_id = isWinnerA
    ? (match.team_b_id || match.team_b_player1_id)
    : (match.team_a_id || match.team_a_player1_id);

  // 1. Knockout progression (legacy slot mapping if defined)
  if (match.next_match_id && match.next_match_slot) {
    const nextMatch = await Match.findOne({ id: match.next_match_id });
    if (nextMatch) {
      const winnerId = isWinnerA ? match.team_a_id : match.team_b_id;
      const winnerP1 = isWinnerA ? match.team_a_player1_id : match.team_b_player1_id;
      const winnerP2 = isWinnerA ? match.team_a_player2_id : match.team_b_player2_id;

      if (match.next_match_slot === "A") {
        nextMatch.team_a_id = winnerId;
        nextMatch.team_a_name = winnerName;
        nextMatch.team_a_player1_id = winnerP1;
        nextMatch.team_a_player2_id = winnerP2;
      } else {
        nextMatch.team_b_id = winnerId;
        nextMatch.team_b_name = winnerName;
        nextMatch.team_b_player1_id = winnerP1;
        nextMatch.team_b_player2_id = winnerP2;
      }
      nextMatch.updated_at = new Date();
      await nextMatch.save();

      const enrichedNext = await enrichMatch(nextMatch);
      realtime.broadcastMatchUpdate(enrichedNext);
    }
  }

  // 2. Tournament Points & Leaderboard (Strictly Idempotent)
  if (!match.points_awarded) {
    let settings = await TournamentSettings.findOne({ id: "default" });
    if (!settings) settings = { points_per_win: 3, points_per_participation: 1 };

    const winPoints = settings.points_per_win || 3;
    const partPoints = settings.points_per_participation || 1;
    const isDoubles = isDoublesCategory(match.category);

    const pointsA = (isWinnerA ? winPoints : 0) + partPoints;
    const pointsB = (!isWinnerA ? winPoints : 0) + partPoints;

    await recordParticipantPoints(
      isDoubles ? "team" : "player",
      match.team_a_id || match.team_a_player1_id,
      match.team_a_name,
      match.category,
      isWinnerA,
      scoreA,
      scoreB,
      pointsA
    );

    await recordParticipantPoints(
      isDoubles ? "team" : "player",
      match.team_b_id || match.team_b_player1_id,
      match.team_b_name,
      match.category,
      !isWinnerA,
      scoreB,
      scoreA,
      pointsB
    );

    match.points_awarded = true;
    await recalculateRanks();
    realtime.broadcastPointsUpdate();
  }

  // 3. Round completion and automatic knockout progression
  if (match.roundId) {
    await checkAndUpdateRoundStatus(match.roundId);
  }
}

async function updateParticipantDirectStats(entityType, entityId, won, scored, conceded, ptsAwarded) {
  try {
    if (entityType === "player") {
      const player = await Player.findOne({ $or: [{ id: entityId }, { player_id: entityId }] });
      if (player) {
        player.matches_played = (player.matches_played || 0) + 1;
        if (won) player.matches_won = (player.matches_won || 0) + 1;
        else player.matches_lost = (player.matches_lost || 0) + 1;
        player.points_scored = (player.points_scored || 0) + scored;
        player.points_conceded = (player.points_conceded || 0) + conceded;
        player.tournament_points = (player.tournament_points || 0) + ptsAwarded;
        player.win_rate = player.matches_played > 0
          ? Math.round((player.matches_won / player.matches_played) * 100)
          : 0;
        player.updated_at = new Date();
        await player.save();
      }
    } else if (entityType === "team") {
      const team = await Team.findOne({ id: entityId });
      if (team) {
        team.matches_played = (team.matches_played || 0) + 1;
        if (won) team.matches_won = (team.matches_won || 0) + 1;
        else team.matches_lost = (team.matches_lost || 0) + 1;
        team.points_scored = (team.points_scored || 0) + scored;
        team.points_conceded = (team.points_conceded || 0) + conceded;
        team.tournament_points = (team.tournament_points || 0) + ptsAwarded;
        team.win_rate = team.matches_played > 0
          ? Math.round((team.matches_won / team.matches_played) * 100)
          : 0;
        team.updated_at = new Date();
        await team.save();

        // Also propagate stats to individual teammates
        if (team.player1_id) {
          await updateParticipantDirectStats("player", team.player1_id, won, scored, conceded, ptsAwarded);
        }
        if (team.player2_id) {
          await updateParticipantDirectStats("player", team.player2_id, won, scored, conceded, ptsAwarded);
        }
      }
    }
  } catch (err) {
    console.error("updateParticipantDirectStats error:", err);
  }
}

async function recordParticipantPoints(entityType, entityId, entityName, category, won, scored, conceded, ptsAwarded) {
  let record = await TournamentPoint.findOne({ entity_id: entityId, category });
  if (record) {
    record.matches_played += 1;
    if (won) record.matches_won += 1;
    else record.matches_lost += 1;
    record.points_scored += scored;
    record.points_conceded += conceded;
    record.total_tournament_points += ptsAwarded;
    record.win_rate = record.matches_played > 0
      ? Math.round((record.matches_won / record.matches_played) * 100)
      : 0;
    record.updated_at = new Date();
    await record.save();
  } else {
    const id = `pts-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
    record = await TournamentPoint.create({
      id,
      entity_type: entityType,
      entity_id: entityId,
      entity_name: entityName,
      category,
      matches_played: 1,
      matches_won: won ? 1 : 0,
      matches_lost: won ? 0 : 1,
      points_scored: scored,
      points_conceded: conceded,
      total_tournament_points: ptsAwarded,
      win_rate: won ? 100 : 0,
      rank: 1,
      category_rank: 1,
      overall_rank: 1,
    });
  }

  // Update Player or Team document directly
  await updateParticipantDirectStats(entityType, entityId, won, scored, conceded, ptsAwarded);

  const logId = `log-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
  await PointHistory.create({
    id: logId,
    entity_type: entityType,
    entity_id: entityId,
    entity_name: entityName,
    category,
    points_delta: ptsAwarded,
    reason: won ? "Match Win + Participation" : "Match Participation",
    adjusted_by: "System / Match Engine",
  });
}

/**
 * Re-indexes all rankings within their respective categories and overall
 */
export async function recalculateRanks() {
  const specificCategories = [
    "Men's Singles",
    "Women's Singles",
    "Men's Doubles",
    "Women's Doubles",
    "Mixed Doubles",
  ];

  // 1. Calculate ranks WITHIN each specific category
  for (const cat of specificCategories) {
    const records = await TournamentPoint.find({ category: cat });
    records.sort((a, b) => {
      if ((b.total_tournament_points || 0) !== (a.total_tournament_points || 0)) {
        return (b.total_tournament_points || 0) - (a.total_tournament_points || 0);
      }
      if ((b.matches_won || 0) !== (a.matches_won || 0)) {
        return (b.matches_won || 0) - (a.matches_won || 0);
      }
      const diffA = (a.points_scored || 0) - (a.points_conceded || 0);
      const diffB = (b.points_scored || 0) - (b.points_conceded || 0);
      return diffB - diffA;
    });

    let catRank = 1;
    for (const rec of records) {
      rec.category_rank = catRank;
      rec.rank = catRank; // Default rank reflects position within their category
      rec.win_rate = rec.matches_played > 0
        ? Math.round((rec.matches_won / rec.matches_played) * 100)
        : 0;
      catRank++;
      await rec.save();
    }
  }

  // 2. Calculate OVERALL rank across all tournament participants
  const allRecords = await TournamentPoint.find({});
  allRecords.sort((a, b) => {
    if ((b.total_tournament_points || 0) !== (a.total_tournament_points || 0)) {
      return (b.total_tournament_points || 0) - (a.total_tournament_points || 0);
    }
    if ((b.matches_won || 0) !== (a.matches_won || 0)) {
      return (b.matches_won || 0) - (a.matches_won || 0);
    }
    const diffA = (a.points_scored || 0) - (a.points_conceded || 0);
    const diffB = (b.points_scored || 0) - (b.points_conceded || 0);
    return diffB - diffA;
  });

  let ovrRank = 1;
  for (const rec of allRecords) {
    rec.overall_rank = ovrRank++;
    await rec.save();
  }
}

/**
 * Self-healing aggregator that synchronizes Player and Team documents directly
 * with all completed match outcomes in MongoDB.
 */
export async function syncAllParticipantStats() {
  try {
    const completedMatches = await Match.find({ status: "completed" });
    let settings = await TournamentSettings.findOne();
    if (!settings) settings = { points_per_win: 3, points_per_participation: 1 };
    const winPoints = settings.points_per_win || 3;
    const partPoints = settings.points_per_participation || 1;

    // Reset player stats
    await Player.updateMany({}, {
      matches_played: 0,
      matches_won: 0,
      matches_lost: 0,
      points_scored: 0,
      points_conceded: 0,
      tournament_points: 0,
      win_rate: 0,
    });

    // Reset team stats
    await Team.updateMany({}, {
      matches_played: 0,
      matches_won: 0,
      matches_lost: 0,
      points_scored: 0,
      points_conceded: 0,
      tournament_points: 0,
      win_rate: 0,
    });

    // Process all completed matches
    for (const m of completedMatches) {
      const isWinnerA = m.winner_team === "A";
      const isDoubles = isDoublesCategory(m.category);
      const ptsA = (isWinnerA ? winPoints : 0) + partPoints;
      const ptsB = (!isWinnerA ? winPoints : 0) + partPoints;

      await updateParticipantDirectStats(
        isDoubles ? "team" : "player",
        m.team_a_id || m.team_a_player1_id,
        isWinnerA,
        m.score_a || 0,
        m.score_b || 0,
        ptsA
      );

      await updateParticipantDirectStats(
        isDoubles ? "team" : "player",
        m.team_b_id || m.team_b_player1_id,
        !isWinnerA,
        m.score_b || 0,
        m.score_a || 0,
        ptsB
      );
    }

    await recalculateRanks();
  } catch (err) {
    console.error("syncAllParticipantStats error:", err);
  }
}
