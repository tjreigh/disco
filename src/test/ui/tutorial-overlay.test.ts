// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CLASSIC_TUTORIAL } from '../../app/tutorial.js';
import { TutorialOverlay } from '../../ui/tutorial-overlay.js';

function overlayRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>('.tutorial-overlay');
  if (!root) throw new Error('Tutorial overlay root not found');
  return root;
}

describe('TutorialOverlay', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('appends a hidden overlay to the document body', () => {
    new TutorialOverlay();

    const root = overlayRoot();
    expect(root.parentElement).toBe(document.body);
    expect(root.classList.contains('tutorial-overlay--visible')).toBe(false);
    expect(root.getAttribute('aria-live')).toBe('polite');
  });

  test('renders the selected tutorial step and hides again', () => {
    const overlay = new TutorialOverlay();

    overlay.show(CLASSIC_TUTORIAL, 1);

    const root = overlayRoot();
    expect(root.classList.contains('tutorial-overlay--visible')).toBe(true);
    expect(root.textContent).toContain('Classic Tutorial 2/4');
    expect(root.textContent).toContain('Clear a column');
    expect(root.textContent).toContain('highlighted column');

    overlay.hide();

    expect(root.classList.contains('tutorial-overlay--visible')).toBe(false);
  });

  test('routes retry and exit button clicks to callbacks', () => {
    const overlay = new TutorialOverlay();
    const onRetry = vi.fn();
    const onExit = vi.fn();
    overlay.onRetry = onRetry;
    overlay.onExit = onExit;

    overlay.show(CLASSIC_TUTORIAL, 0);
    const [retryButton, exitButton] = Array.from(document.querySelectorAll<HTMLButtonElement>('.tutorial-button'));
    retryButton!.click();
    exitButton!.click();

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test('complete prompt can continue immediately and auto-dismisses', () => {
    vi.useFakeTimers();
    const overlay = new TutorialOverlay();
    const onRetry = vi.fn();
    const onContinue = vi.fn();
    overlay.onRetry = onRetry;
    overlay.onContinue = onContinue;

    overlay.showComplete(CLASSIC_TUTORIAL, 'Classic');

    const root = overlayRoot();
    expect(root.classList.contains('tutorial-overlay--visible')).toBe(true);
    expect(root.textContent).toContain('Tutorial Complete');
    expect(root.textContent).toContain('You can keep playing from here in Classic mode.');

    document.querySelector<HTMLButtonElement>('.tutorial-button')!.click();

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_000);

    expect(onContinue).toHaveBeenCalledTimes(2);
  });

  test('setAimingPrompt swaps the prompt and aiming class; null restores the step prompt', () => {
    const overlay = new TutorialOverlay();
    overlay.show(CLASSIC_TUTORIAL, 0);
    const root = overlayRoot();
    const prompt = root.querySelector('.tutorial-prompt')!;
    const stepPrompt = CLASSIC_TUTORIAL.steps[0]!.prompt;
    expect(prompt.textContent).toBe(stepPrompt);

    overlay.setAimingPrompt('Now tilt to finish the turn.');
    expect(prompt.textContent).toBe('Now tilt to finish the turn.');
    expect(root.classList.contains('tutorial-overlay--aiming')).toBe(true);

    overlay.setAimingPrompt(null);
    expect(prompt.textContent).toBe(stepPrompt);
    expect(root.classList.contains('tutorial-overlay--aiming')).toBe(false);
  });

  test('show() resets a lingering aiming override to the new step prompt', () => {
    const overlay = new TutorialOverlay();
    overlay.show(CLASSIC_TUTORIAL, 0);
    overlay.setAimingPrompt('Tilt now.');

    overlay.show(CLASSIC_TUTORIAL, 1);

    const root = overlayRoot();
    expect(root.querySelector('.tutorial-prompt')!.textContent).toBe(CLASSIC_TUTORIAL.steps[1]!.prompt);
    expect(root.classList.contains('tutorial-overlay--aiming')).toBe(false);
  });

  test('showComplete() adopts the completion copy as the base prompt — a later restore cannot resurrect a stale step prompt', () => {
    const overlay = new TutorialOverlay();
    overlay.show(CLASSIC_TUTORIAL, 0);
    overlay.setAimingPrompt('Tilt now.');

    overlay.showComplete(CLASSIC_TUTORIAL, 'Gravity');
    overlay.setAimingPrompt(null);

    const root = overlayRoot();
    expect(root.querySelector('.tutorial-prompt')!.textContent).toBe('You can keep playing from here in Gravity mode.');
    expect(root.classList.contains('tutorial-overlay--aiming')).toBe(false);
  });

  test('clicking retry hands focus back so game keys stay alive', () => {
    const overlay = new TutorialOverlay();
    overlay.show(CLASSIC_TUTORIAL, 0);

    const retryButton = document.querySelector<HTMLButtonElement>('.tutorial-button')!;
    retryButton.focus();
    retryButton.click();

    expect(document.activeElement).not.toBe(retryButton);
  });

  test('complete prompt names whichever mode the tutorial was actually for', () => {
    const overlay = new TutorialOverlay();
    overlay.showComplete(CLASSIC_TUTORIAL, 'Gravity');

    expect(overlayRoot().textContent).toContain('You can keep playing from here in Gravity mode.');
    expect(overlayRoot().textContent).not.toContain('Classic mode.');
  });

  test('hide clears the complete auto-dismiss timer', () => {
    vi.useFakeTimers();
    const overlay = new TutorialOverlay();
    const onContinue = vi.fn();
    overlay.onContinue = onContinue;

    overlay.showComplete(CLASSIC_TUTORIAL, 'Classic');
    overlay.hide();
    vi.advanceTimersByTime(4_000);

    expect(onContinue).not.toHaveBeenCalled();
  });
});
