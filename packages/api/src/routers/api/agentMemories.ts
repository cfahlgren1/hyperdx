import express from 'express';
import { z } from 'zod';
import { processRequest } from 'zod-express-middleware';

import AgentMemory from '@/models/agentMemory';

const router = express.Router();

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);

// The agent's own writes go through the internal listener with the same caps;
// this router is the human side of the same store (view, correct, delete).
router.get('/', async (req, res, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      return res.sendStatus(403);
    }
    const memories = await AgentMemory.find({ team: teamId })
      .sort({ updatedAt: -1 })
      .limit(100);
    res.json({
      data: memories.map(m => ({
        slug: m.slug,
        content: m.content,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.put(
  '/:slug',
  processRequest({
    params: z.object({ slug: slugSchema }),
    body: z.object({ content: z.string().min(1).max(4096) }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }
      await AgentMemory.findOneAndUpdate(
        { team: teamId, slug: req.params.slug },
        { $set: { content: req.body.content } },
        { upsert: true },
      );
      res.sendStatus(204);
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  '/:slug',
  processRequest({ params: z.object({ slug: slugSchema }) }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }
      const result = await AgentMemory.deleteOne({
        team: teamId,
        slug: req.params.slug,
      });
      if (result.deletedCount === 0) {
        return res.sendStatus(404);
      }
      res.sendStatus(204);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
