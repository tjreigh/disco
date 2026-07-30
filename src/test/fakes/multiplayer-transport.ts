import type { MultiplayerSessionTransport } from '../../app/multiplayer-session-controller.js';
import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
} from '../../shared/multiplayer-contracts.js';

export class FakeMultiplayerTransport implements MultiplayerSessionTransport {
  readonly sent: MultiplayerClientMessage[] = [];

  private messageListener: ((message: unknown) => void) | null = null;
  private connectionListener: ((state: MultiplayerConnectionState) => void) | null = null;

  send(message: MultiplayerClientMessage): void {
    this.sent.push(message);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return () => {
      if (this.messageListener === listener) this.messageListener = null;
    };
  }

  subscribeConnection(listener: (state: MultiplayerConnectionState) => void): () => void {
    this.connectionListener = listener;
    return () => {
      if (this.connectionListener === listener) this.connectionListener = null;
    };
  }

  receive(message: unknown): void {
    this.messageListener?.(message);
  }

  setConnection(state: MultiplayerConnectionState): void {
    this.connectionListener?.(state);
  }
}
