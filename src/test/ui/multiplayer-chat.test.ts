// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import type { ChatLogEntry } from '../../app/multiplayer-chat-log.js';
import { MultiplayerChat } from '../../ui/multiplayer-chat.js';

function message(playerId: string, text: string): ChatLogEntry {
  return { kind: 'message', playerId, text };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('MultiplayerChat', () => {
  test('renders messages and notices as text, never as markup', () => {
    const chat = new MultiplayerChat(document.body);
    chat.render([
      message('me', '<img src=x onerror=alert(1)>'),
      message('them', 'hello'),
      { kind: 'notice', text: 'slow down' },
    ], 'me', false);

    const entries = document.querySelectorAll('.multiplayer-chat__entry');
    expect(entries).toHaveLength(3);
    expect(document.querySelector('img')).toBeNull();
    expect(entries[0]?.textContent).toBe('YOU<img src=x onerror=alert(1)>');
    expect(entries[0]?.getAttribute('data-owner')).toBe('you');
    expect(entries[1]?.getAttribute('data-owner')).toBe('opponent');
    expect(entries[2]?.classList.contains('multiplayer-chat__entry--notice')).toBe(true);
  });

  test('sends a trimmed message and clears the input on success', () => {
    const chat = new MultiplayerChat(document.body);
    let sent: string | null = null;
    chat.setOnSend(text => {
      sent = text;
      return true;
    });
    chat.render([], 'me', false);

    const input = document.querySelector<HTMLInputElement>('.multiplayer-chat__input')!;
    input.value = '  hi  ';
    document.querySelector<HTMLFormElement>('.multiplayer-chat__form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(sent).toBe('hi');
    expect(input.value).toBe('');
  });

  test('keeps the text when the send is rejected locally', () => {
    const chat = new MultiplayerChat(document.body);
    chat.setOnSend(() => false);
    chat.render([], 'me', false);

    const input = document.querySelector<HTMLInputElement>('.multiplayer-chat__input')!;
    input.value = 'keep me';
    document.querySelector<HTMLFormElement>('.multiplayer-chat__form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(input.value).toBe('keep me');
  });

  test('toggle reveals and hides the panel', () => {
    const chat = new MultiplayerChat(document.body);
    chat.render([], 'me', false);

    const toggle = document.querySelector<HTMLButtonElement>('.multiplayer-chat__toggle')!;
    const panel = document.querySelector<HTMLElement>('.multiplayer-chat__panel')!;
    expect(panel.hidden).toBe(true);

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(panel.hidden).toBe(true);
  });

  test('disables input and send while disconnected and enforces maxlength', () => {
    const chat = new MultiplayerChat(document.body);
    chat.render([], 'me', false);

    const input = document.querySelector<HTMLInputElement>('.multiplayer-chat__input')!;
    expect(input.maxLength).toBe(500);

    chat.render([], 'me', true);
    expect(input.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.multiplayer-chat__send')!.disabled).toBe(true);
  });

  test('rerenders when bounded history rolls over at a stable length', () => {
    const chat = new MultiplayerChat(document.body);
    const first = Array.from({ length: 100 }, (_, index) => message('them', `message ${index}`));
    chat.render(first, 'me', false);
    const rollover = [...first.slice(1), message('them', 'message 100')];
    chat.render(rollover, 'me', false);

    const entries = document.querySelectorAll('.multiplayer-chat__entry');
    expect(entries).toHaveLength(100);
    expect(entries[0]?.textContent).toContain('message 1');
    expect(entries[99]?.textContent).toContain('message 100');
  });

  test('shows an unread count for closed-panel opponent messages and clears it when opened', () => {
    const chat = new MultiplayerChat(document.body);
    chat.render([message('them', 'hello'), message('me', 'hi'), message('them', 'again')], 'me', false);

    const toggle = document.querySelector<HTMLButtonElement>('.multiplayer-chat__toggle')!;
    const unread = document.querySelector<HTMLElement>('.multiplayer-chat__unread')!;
    expect(unread.hidden).toBe(false);
    expect(unread.textContent).toBe('2');
    expect(toggle.getAttribute('aria-label')).toBe('Open chat (2 unread messages)');

    toggle.click();
    expect(unread.hidden).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Open chat');
  });
});
