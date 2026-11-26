import mongoose from "mongoose";
import TournamentPoint from "../models/TournamentPoint.js";
import PointHistory from "../models/PointHistory.js";
import Player from "../models/Player.js";
import Team from "../models/Team.js";
import Match from "../models/Match.js";
import { recalculateRanks } from "./matchController.js";
import { isDoublesCategory } from "../services/scoringEngine.js";
import { realtime } from "../services/realtimeService.js";

export async function getPoints(req, res) {
  try {
    const { category, entityType } = req.query;
    const filter = {};

    if (category && category !== "All") filter.category = category;
    if (entityType && entityType !== "both") filter.entity_type = entityType;

    const dbRecords = await TournamentPoint.find(filter).sort({
      rank: 1,
      total_tournament_points: -1,
      matches_won: -1,
    });

    // Overlay active live/paused/tied matches so rally points update in real time
    const liveMatchFilter = { status: { $in: ["live", "paused", "tied"] } };
    if (category && category !== "All") liveMatchFilter.category = category;
    const liveMatches = await Match.find(liveMatchFilter);

    const recordMap = new Map();
    const leaderboard = dbRecords.map((doc) => {
      const obj = doc.toObject();
      recordMap.set(`${obj.entity_id}::${obj.category}`, obj);
      return obj;
    });

    const overlayLiveParticipant = (entType, entId, entName, cat, scored, conceded) => {
      if (!entId) return;
      if (entityType && entityType !== "both" && entType !== entityType) return;

      const key = `${entId}::${cat}`;
      const existing = recordMap.get(key);
      if (existing) {
        existing.points_scored = (existing.points_scored || 0) + (scored || 0);
        existing.points_conceded = (existing.points_conceded || 0) + (conceded || 0);
        existing.is_live = true;
      } else {
        const virtualEntry = {
          id: `live-${entId}-${cat}`,
          entity_type: entType,
          entity_id: entId,
          entity_name: entName || entId,
          category: cat,
          matches_played: 0,
          matches_won: 0,
          matches_lost: 0,
          points_scored: scored || 0,
          points_conceded: conceded || 0,
          total_tournament_points: 0,
          rank: 999,
          category_rank: 999,
          overall_rank: 999,
          win_rate: 0,
          is_live: true,
        };
        recordMap.set(key, virtualEntry);
        leaderboard.push(virtualEntry);
      }
    };

    for (const m of liveMatches) {
      const isDoubles = isDoublesCategory(m.category);
      const entType = isDoubles ? "team" : "player";
      overlayLiveParticipant(
        entType,
        m.team_a_id || m.team_a_player1_id,
        m.team_a_name,
        m.category,
        m.score_a || 0,
        m.score_b || 0
      );
      overlayLiveParticipant(
        entType,
        m.team_b_id || m.team_b_player1_id,
        m.team_b_name,
        m.category,
        m.score_b || 0,
        m.score_a || 0
      );
    }

    leaderboard.sort((a, b) => {
      if ((b.total_tournament_points || 0) !== (a.total_tournament_points || 0)) {
        return (b.total_tournament_points || 0) - (a.total_tournament_points || 0);
      }
      if ((b.matches_won || 0) !== (a.matches_won || 0)) {
        return (b.matches_won || 0) - (a.matches_won || 0);
      }
      const diffA = (a.points_scored || 0) - (a.points_conceded || 0);
      const diffB = (b.points_scored || 0) - (b.points_conceded || 0);
      if (diffB !== diffA) return diffB - diffA;
      return (b.points_scored || 0) - (a.points_scored || 0);
    });

    const history = await PointHistory.find().sort({ created_at: -1 }).limit(100);

    const categories = [
      "Men's Singles",
      "Women's Singles",
      "Men's Doubles",
      "Women's Doubles",
      "Mixed Doubles",
    ];

    // Compute top leaders for each category from merged leaderboard
    const categoryLeaders = {};
    for (const cat of categories) {
      const catRecords = leaderboard.filter((r) => r.category === cat);
      categoryLeaders[cat] = {
        leader: catRecords[0] || null,
        totalParticipants: catRecords.length,
      };
    }

    return res.json({
      leaderboard,
      history,
      categoryLeaders,
      categories,
    });
  } catch (error) {
    console.error("GetPoints error:", error);
    return res.status(500).json({ error: "Failed to fetch leaderboard data." });
  }
}

export async function adjustPoints(req, res) {
  try {
    const { entityId, entityType, entityName, category, delta, reason, adjustedBy } = req.body;
    const numDelta = Number(delta);

    if (!numDelta || isNaN(numDelta)) {
      return res.status(400).json({ error: "Valid points delta required." });
    }
    if (!reason) {
      return res.status(400).json({ error: "Adjustment reason is required." });
    }

    let record = await TournamentPoint.findOne({ entity_id: entityId, category });
    if (record) {
      record.total_tournament_points += numDelta;
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
        total_tournament_points: numDelta,
        rank: 1,
      });
    }

    const logId = `log-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
    await PointHistory.create({
      id: logId,
      entity_type: entityType,
      entity_id: entityId,
      entity_name: entityName,
      category,
      points_delta: numDelta,
      reason,
      adjusted_by: adjustedBy || req.admin?.name || "Admin",
    });

    await recalculateRanks();
    realtime.broadcastPointsUpdate();

    return res.json({ success: true, message: "Points adjusted successfully." });
  } catch (error) {
    console.error("AdjustPoints error:", error);
    return res.status(400).json({ error: error.message || "Failed to adjust points." });
  }
}

export async function updatePointEntry(req, res) {
  try {
    const rawId = req.params.id;
    const isObjId = mongoose.isValidObjectId(rawId);
    const record = await TournamentPoint.findOne({
      $or: [{ id: rawId }, ...(isObjId ? [{ _id: rawId }] : [])],
    });

    if (!record) {
      return res.status(404).json({ error: "Leaderboard entry not found." });
    }

    const oldTotal = Number(record.total_tournament_points || 0);
    const {
      entity_name,
      category,
      matches_played,
      matches_won,
      matches_lost,
      points_scored,
      points_conceded,
      total_tournament_points,
      reason,
    } = req.body;

    if (entity_name && entity_name.trim()) record.entity_name = entity_name.trim();
    if (category && category.trim()) record.category = category.trim();
    if (matches_played !== undefined) record.matches_played = Math.max(0, Number(matches_played) || 0);
    if (matches_won !== undefined) record.matches_won = Math.max(0, Number(matches_won) || 0);
    if (matches_lost !== undefined) record.matches_lost = Math.max(0, Number(matches_lost) || 0);
    if (points_scored !== undefined) record.points_scored = Math.max(0, Number(points_scored) || 0);
    if (points_conceded !== undefined) record.points_conceded = Math.max(0, Number(points_conceded) || 0);
    if (total_tournament_points !== undefined && !isNaN(Number(total_tournament_points))) {
      record.total_tournament_points = Number(total_tournament_points);
    }

    record.win_rate =
      record.matches_played > 0
        ? Math.round((record.matches_won / record.matches_played) * 100)
        : 0;
    record.updated_at = new Date();
    await record.save();

    const newTotal = Number(record.total_tournament_points || 0);
    const logId = `log-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
    await PointHistory.create({
      id: logId,
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      entity_name: record.entity_name,
      category: record.category,
      points_delta: newTotal - oldTotal,
      reason: (reason && reason.trim()) || "Manual Leaderboard Edit",
      adjusted_by: req.admin?.name || "Admin",
    });

    await recalculateRanks();

    // Sync corresponding Player / Team document stats so all pages stay consistent
    const statUpdate = {
      matches_played: record.matches_played,
      matches_won: record.matches_won,
      matches_lost: record.matches_lost,
      points_scored: record.points_scored,
      points_conceded: record.points_conceded,
      tournament_points: record.total_tournament_points,
      win_rate: record.win_rate,
      updated_at: new Date(),
    };
    if (record.entity_type === "player") {
      await Player.updateOne({ id: record.entity_id }, { $set: statUpdate });
    } else if (record.entity_type === "team") {
      await Team.updateOne({ id: record.entity_id }, { $set: statUpdate });
    }

    realtime.broadcastPointsUpdate({ id: record.id, updated: true });

    return res.json({ success: true, record });
  } catch (error) {
    console.error("UpdatePointEntry error:", error);
    return res.status(400).json({ error: error.message || "Failed to update leaderboard entry." });
  }
}

export async function deletePointEntry(req, res) {
  try {
    const rawId = req.params.id;
    const isObjId = mongoose.isValidObjectId(rawId);
    const record = await TournamentPoint.findOneAndDelete({
      $or: [{ id: rawId }, ...(isObjId ? [{ _id: rawId }] : [])],
    });

    if (!record) {
      return res.status(404).json({ error: "Leaderboard entry not found." });
    }

    const logId = `log-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
    await PointHistory.create({
      id: logId,
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      entity_name: record.entity_name,
      category: record.category,
      points_delta: -(record.total_tournament_points || 0),
      reason: "Removed from Leaderboard",
      adjusted_by: req.admin?.name || "Admin",
    });

    await recalculateRanks();
    realtime.broadcastPointsUpdate();

    return res.json({ success: true, message: "Leaderboard entry deleted." });
  } catch (error) {
    console.error("DeletePointEntry error:", error);
    return res.status(500).json({ error: "Failed to delete leaderboard entry." });
  }
}

export async function resetLeaderboard(req, res) {
  try {
    await TournamentPoint.deleteMany({});
    await PointHistory.deleteMany({});

    const zeroStats = {
      matches_played: 0,
      matches_won: 0,
      matches_lost: 0,
      points_scored: 0,
      points_conceded: 0,
      tournament_points: 0,
      win_rate: 0,
    };

    await Player.updateMany({}, { $set: zeroStats });
    await Team.updateMany({}, { $set: zeroStats });

    realtime.broadcastPointsUpdate();
    return res.json({ success: true, message: "Leaderboard and all points data cleared." });
  } catch (error) {
    console.error("ResetLeaderboard error:", error);
    return res.status(500).json({ error: "Failed to reset leaderboard." });
  }
}
