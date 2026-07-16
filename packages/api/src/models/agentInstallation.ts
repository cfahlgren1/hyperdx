import mongoose, { Schema } from 'mongoose';

type ObjectId = mongoose.Types.ObjectId;

export const AGENT_CREDENTIAL_PREFIX = 'hdx_agent_';

interface IAgentInstallation {
  _id: ObjectId;
  team: ObjectId;
  credential: string;
  createdAt: Date;
  updatedAt: Date;
}

export type AgentInstallationDocument =
  mongoose.HydratedDocument<IAgentInstallation>;

const AgentInstallationSchema = new Schema(
  {
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
      immutable: true,
    },
    credential: {
      type: String,
      required: true,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

AgentInstallationSchema.index({ team: 1 }, { unique: true });
AgentInstallationSchema.index({ credential: 1 }, { unique: true });

export default mongoose.model<IAgentInstallation>(
  'AgentInstallation',
  AgentInstallationSchema,
);
