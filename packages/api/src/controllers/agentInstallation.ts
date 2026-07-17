import { randomBytes } from 'crypto';

import AgentInstallation, {
  AGENT_CREDENTIAL_PREFIX,
  AgentInstallationDocument,
} from '@/models/agentInstallation';

function generateAgentCredential(): string {
  return `${AGENT_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Return the team's agent credential, minting one on first call. Concurrency
 * safe: the upsert only sets the credential on insert, and a duplicate-key
 * race on the unique team index resolves by re-reading the winner.
 */
export async function ensureAgentCredential(teamId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const installation = await AgentInstallation.findOneAndUpdate(
        { team: teamId },
        {
          $setOnInsert: { team: teamId, credential: generateAgentCredential() },
        },
        { upsert: true, new: true },
      ).select('+credential');
      if (installation?.credential) {
        return installation.credential;
      }
    } catch (e: any) {
      if (e?.code !== 11000 || attempt === 1) {
        throw e;
      }
    }
  }
  throw new Error('Failed to provision agent credential');
}

export async function findAgentInstallationByCredential(
  credential: string,
): Promise<AgentInstallationDocument | null> {
  if (!credential.startsWith(AGENT_CREDENTIAL_PREFIX)) {
    return null;
  }
  return AgentInstallation.findOne({ credential });
}
