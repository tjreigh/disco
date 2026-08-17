import { describe, expect, test } from 'vitest';
import {
  MAX_CHAT_HISTORY,
  MultiplayerChatLog,
} from '../../app/multiplayer-chat-log.js';

function chatMessage(playerId: string, text: string) {
  return { playerId, text };
}

describe('MultiplayerChatLog', () => {
  test('accepts local and first-observed non-local senders', () => {
    const log = new MultiplayerChatLog('me');
    log.receive(chatMessage('me', 'one'));
    log.receive(chatMessage('them', 'two'));
    expect(log.view).toEqual([
      { kind: 'message', playerId: 'me', text: 'one' },
      { kind: 'message', playerId: 'them', text: 'two' },
    ]);
  });

  test('rejects a third identity after the opponent is learned', () => {
    const log = new MultiplayerChatLog('me');
    log.receive(chatMessage('them', 'hello'));
    log.receive(chatMessage('intruder', 'hello?'));
    expect(log.view).toEqual([
      { kind: 'message', playerId: 'them', text: 'hello' },
    ]);
  });

  test('bounds history to the newest entries', () => {
    const log = new MultiplayerChatLog('me');
    for (let index = 0; index < MAX_CHAT_HISTORY + 5; index++) {
      log.receive(chatMessage('me', `message-${index}`));
    }
    expect(log.view).toHaveLength(MAX_CHAT_HISTORY);
    expect(log.view[0]).toEqual({ kind: 'message', playerId: 'me', text: 'message-5' });
    expect(log.view.at(-1)).toEqual({
      kind: 'message',
      playerId: 'me',
      text: `message-${MAX_CHAT_HISTORY + 4}`,
    });
  });

  test('noteThrottled appends a notice entry', () => {
    const log = new MultiplayerChatLog('me');
    log.noteThrottled();
    expect(log.view).toEqual([{ kind: 'notice', text: expect.any(String) }]);
  });
});
