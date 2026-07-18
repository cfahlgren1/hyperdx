import mongoose, { Schema } from 'mongoose';

type ObjectId = mongoose.Types.ObjectId;

/**
 * A durable note the on-call agent keeps about the environment (one markdown
 * file in its memory/ directory). Written only through the internal listener's
 * validated sync endpoint; rendered back into the agent's sandbox on each run.
 */
interface IAgentMemory {
  _id: ObjectId;
  team: ObjectId;
  slug: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const AgentMemorySchema = new Schema<IAgentMemory>(
  {
    team: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Team',
    },
    slug: { type: String, required: true },
    content: { type: String, required: true },
  },
  { timestamps: true },
);

AgentMemorySchema.index({ team: 1, slug: 1 }, { unique: true });

export default mongoose.model<IAgentMemory>('AgentMemory', AgentMemorySchema);
