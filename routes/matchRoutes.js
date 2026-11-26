import { Router } from "express";
import {
  getMatches,
  getMatch,
  createMatch,
  updateMatch,
  deleteMatch,
  updateStatus,
  scoreMatchPoint,
  undoPoint,
  recordMatchLet,
  handleTimerAction,
  restartMatch,
} from "../controllers/matchController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

router.get("/", getMatches);
router.get("/:id", getMatch);
router.post("/", requireAdmin, createMatch);
router.put("/:id", requireAdmin, updateMatch);
router.delete("/:id", requireAdmin, deleteMatch);

// Scoring and Match Controls
router.post("/:id/status", requireAdmin, updateStatus);
router.post("/:id/restart", requireAdmin, restartMatch);
router.post("/:id/score", requireAdmin, scoreMatchPoint);
router.post("/:id/undo", requireAdmin, undoPoint);
router.post("/:id/let", requireAdmin, recordMatchLet);

// Timer controls (check, pause, resume, reset)
router.get("/:id/timer", getMatch); // Return match state including timer
router.put("/:id/timer", requireAdmin, handleTimerAction);

export default router;
