import type { MultiplayerModeDefinition } from '../game/modes/mode.js';
import {
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../shared/multiplayer-contracts.js';
import type {
  MultiplayerModeIdentity,
} from '../shared/multiplayer-contracts.js';
import {
  ApiRequestError,
  configuredApiBaseUrl,
} from './api-client.js';

export interface MultiplayerAdmission {
  readonly roomId: string;
  readonly playerId: string;
  readonly reconnectCredential: string;
  readonly mode: MultiplayerModeIdentity;
}

export class MultiplayerApiClient {
  readonly baseUrl: string;

  constructor(baseUrl = configuredApiBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async createRoom(mode: MultiplayerModeDefinition): Promise<MultiplayerAdmission> {
    return await this.admit('/multiplayer/rooms', mode);
  }

  async joinRoom(
    roomId: string,
    mode: MultiplayerModeDefinition,
  ): Promise<MultiplayerAdmission> {
    return await this.admit(
      `/multiplayer/rooms/${encodeURIComponent(roomId)}/join`,
      mode,
    );
  }

  private async admit(
    path: string,
    mode: MultiplayerModeDefinition,
  ): Promise<MultiplayerAdmission> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        mode: multiplayerModeIdentity(mode),
      }),
    });
    if (!response.ok) throw new ApiRequestError(response.status);
    return await response.json() as MultiplayerAdmission;
  }
}
