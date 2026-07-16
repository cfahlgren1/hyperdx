import mongoose, { Schema } from 'mongoose';
import ms from 'ms';

import { AlertState } from '@/models/alert';

import type { ObjectId } from '.';

// Set when a fresh alert fire triggers an agent investigation: `requestedAt`
// = requested, `summary` = delivered. A failed investigation simply never
// gets a summary (at-most-once by design).
interface IAlertInvestigation {
  requestedAt: Date;
  summary?: string;
  completedAt?: Date;
}

export interface IAlertHistory {
  alert: ObjectId;
  counts: number;
  createdAt: Date;
  state: AlertState;
  lastValues: { startTime: Date; count: number }[];
  group?: string; // For group-by alerts, stores the group identifier
  fired?: boolean;
  investigation?: IAlertInvestigation;
}

const AlertHistorySchema = new Schema<IAlertHistory>({
  counts: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    required: true,
  },
  alert: { type: mongoose.Schema.Types.ObjectId, ref: 'Alert' },
  state: {
    type: String,
    enum: Object.values(AlertState),
    required: true,
  },
  lastValues: [
    {
      startTime: {
        type: Date,
        required: true,
      },
      count: {
        type: Number,
        required: true,
      },
    },
  ],
  group: {
    type: String,
    required: false,
  },
  fired: {
    type: Boolean,
    required: false,
  },
  investigation: {
    required: false,
    type: {
      _id: false,
      requestedAt: {
        type: Date,
        required: true,
      },
      summary: {
        type: String,
        required: false,
      },
      completedAt: {
        type: Date,
        required: false,
      },
    },
  },
});

AlertHistorySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: ms('30d') / 1000 },
);

// Used by getRecentAlertHistories (matches on alert, sorts by createdAt)
AlertHistorySchema.index({ alert: 1, createdAt: -1 });

// Used by getPreviousAlertHistories (groups by {alert, group}, sorts by createdAt)
AlertHistorySchema.index({ alert: 1, group: 1, createdAt: -1 });

// Used by getRecentInvestigations: only histories with a delivered summary
// are indexed, so the newest-first scan touches investigation docs only.
AlertHistorySchema.index(
  { createdAt: -1 },
  { partialFilterExpression: { 'investigation.summary': { $exists: true } } },
);

export default mongoose.model<IAlertHistory>(
  'AlertHistory',
  AlertHistorySchema,
);
