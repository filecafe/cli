import { Chalk, type ChalkInstance } from 'chalk';
import type { Output } from './context.ts';

type Env = Record<string, string | undefined>;

/**
 * Colors for text written to `stream`: on for a terminal, off when piped (scripts, CI logs,
 * AI agents) or when NO_COLOR is set. FORCE_COLOR=1 or 0 overrides both.
 */
export function colorsFor(stream: Output, env: Env): ChalkInstance {
  return new Chalk({ level: useColor(stream, env) ? 1 : 0 });
}

function useColor(stream: Output, env: Env): boolean {
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  }

  return !env.NO_COLOR && Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

/**
 * Whether `stream` is a terminal that understands OSC 8 hyperlinks (link text that opens a
 * different URL when clicked). Terminals that don't would print the escape codes as garbage,
 * so this only says yes for ones known to support them. FORCE_HYPERLINK=1 or 0 overrides it.
 */
export function supportsHyperlinks(stream: Output, env: Env): boolean {
  if (env.FORCE_HYPERLINK !== undefined) {
    return env.FORCE_HYPERLINK !== '0';
  }

  if (!stream.isTTY || env.CI || env.TERM === 'dumb') {
    return false;
  }

  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.KONSOLE_VERSION || env.DOMTERM) {
    return true;
  }

  if (Number(env.VTE_VERSION) >= 5000) {
    return true;
  }

  return ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby', 'rio'].includes(env.TERM_PROGRAM ?? '');
}

/** `text` that opens `url` when clicked, for terminals where supportsHyperlinks() is true. */
export function hyperlink(text: string, url: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

/**
 * A URL styled like the Vercel CLI's links: cyan and clickable where the terminal supports
 * links (which usually underline it themselves), otherwise cyan and underlined.
 */
export function styledUrl(stream: Output, env: Env, url: string): string {
  const color = colorsFor(stream, env);

  return supportsHyperlinks(stream, env) ? hyperlink(color.cyan(url), url) : color.cyan.underline(url);
}

export interface Spinner {
  /** Erase the spinner line. Safe to call more than once. */
  stop(): void;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];

/**
 * Show `text` with a spinner in front of it on a terminal, erased by stop(). Anywhere else
 * (a log file, CI, an AI agent) the text is written once as a plain line instead.
 */
export function startSpinner(stream: Output, text: string, env: Env, platform: NodeJS.Platform): Spinner {
  if (!stream.isTTY || env.CI || env.TERM === 'dumb') {
    stream.write(`${text}\n`);

    return { stop: () => {} };
  }

  // The old Windows console can't draw braille; Windows Terminal (WT_SESSION) can.
  const frames = platform === 'win32' && !env.WT_SESSION ? ASCII_FRAMES : FRAMES;
  const color = colorsFor(stream, env);
  let frame = 0;
  const draw = () => stream.write(`\r${color.cyan(frames[frame++ % frames.length])} ${text}`);

  draw();

  const timer = setInterval(draw, 80);
  timer.unref();

  let stopped = false;

  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        stream.write('\r\u001B[2K');
      }
    },
  };
}
