import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { colorsFor, hyperlink, startSpinner, supportsHyperlinks } from '../src/terminal.ts';

const tty = { isTTY: true, write: () => true };

describe('supportsHyperlinks', () => {
  it('only says yes for terminals known to support them', () => {
    assert.equal(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app' }), true);
    assert.equal(supportsHyperlinks(tty, { TERM_PROGRAM: 'ghostty' }), true);
    assert.equal(supportsHyperlinks(tty, { WT_SESSION: 'abc' }), true);
    assert.equal(supportsHyperlinks(tty, { VTE_VERSION: '7600' }), true);
    assert.equal(supportsHyperlinks(tty, { TERM_PROGRAM: 'Apple_Terminal' }), false);
    assert.equal(supportsHyperlinks(tty, {}), false);
  });

  it('never uses them when piped or in CI, unless forced', () => {
    assert.equal(supportsHyperlinks({ write: () => true }, { TERM_PROGRAM: 'iTerm.app' }), false);
    assert.equal(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app', CI: 'true' }), false);
    assert.equal(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app', FORCE_HYPERLINK: '0' }), false);
    assert.equal(supportsHyperlinks({ write: () => true }, { FORCE_HYPERLINK: '1' }), true);
  });

  it('wraps the text in an OSC 8 link', () => {
    assert.equal(hyperlink('file.cafe', 'https://file.cafe/x'), '\u001B]8;;https://file.cafe/x\u0007file.cafe\u001B]8;;\u0007');
  });
});

describe('colorsFor', () => {
  const red = (stream: { isTTY?: boolean; write: () => boolean }, env: Record<string, string>) => colorsFor(stream, env).red('x');

  it('colors terminal output only', () => {
    assert.equal(red(tty, {}), '\u001B[31mx\u001B[39m');
    assert.equal(red({ write: () => true }, {}), 'x');
    assert.equal(red(tty, { TERM: 'dumb' }), 'x');
  });

  it('respects NO_COLOR, and FORCE_COLOR over everything', () => {
    assert.equal(red(tty, { NO_COLOR: '1' }), 'x');
    assert.equal(red({ write: () => true }, { FORCE_COLOR: '1' }), '\u001B[31mx\u001B[39m');
    assert.equal(red(tty, { NO_COLOR: '1', FORCE_COLOR: '1' }), '\u001B[31mx\u001B[39m');
    assert.equal(red(tty, { FORCE_COLOR: '0' }), 'x');
  });
});

describe('startSpinner', () => {
  it('writes a plain line when not on a terminal', () => {
    let out = '';
    const spinner = startSpinner({ write: (chunk: string) => (out += chunk) }, 'Waiting...', { NO_COLOR: '1' }, 'linux');

    spinner.stop();

    assert.equal(out, 'Waiting...\n');
  });

  it('animates on a terminal and erases its line when stopped', () => {
    let out = '';
    const spinner = startSpinner({ isTTY: true, write: (chunk: string) => (out += chunk) }, 'Waiting...', { NO_COLOR: '1' }, 'linux');

    spinner.stop();
    spinner.stop();

    assert.equal(out, '\r⠋ Waiting...\r\u001B[2K');
  });

  it('uses ASCII frames in the old Windows console', () => {
    let out = '';
    startSpinner({ isTTY: true, write: (chunk: string) => (out += chunk) }, 'Waiting...', { NO_COLOR: '1' }, 'win32').stop();

    assert.match(out, /^\r- Waiting\.\.\./);
  });
});
