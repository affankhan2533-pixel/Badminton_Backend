import { Router } from "express";
import {
  getPoints,
  adjustPoints,
  updatePointEntry,
  deletePointEntry,
  resetLeaderboard,
} from "../controllers/pointController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

router.get("/", getPoints);
router.post("/", requireAdmin, adjustPoints);
router.put("/:id", requireAdmin, updatePointEntry);
router.delete("/:id", requireAdmin, deletePointEntry);
router.delete("/", requireAdmin, resetLeaderboard);

export default router;
