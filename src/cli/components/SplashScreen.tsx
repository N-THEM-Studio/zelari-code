/**
 * SplashScreen — one-shot startup splash (v0.7.8).
 *
 * Shows the N-THEM / Zelari emblem (downscaled from the original 400-col
 * ASCII art) centered in the terminal for ~2 seconds — or until any key is
 * pressed — then unmounts and gives way to the normal App.
 *
 * Sizing: four pre-rendered variants (64/44/30/22 columns wide) are
 * embedded as constants; `pickSplashArt` chooses the largest one that fits
 * the current terminal (dropping the version/hint footer on short panes),
 * or returns null when even the micro one doesn't fit (the splash is then
 * skipped entirely).
 *
 * Skipped when stdout is not a TTY (pipes, CI) or `ZELARI_NO_SPLASH=1`.
 */

// NOTE: no import from '../main.js' here — main.ts executes `main()` at
// module scope, so importing it from a component (or a unit test that
// imports this component) would boot the whole CLI. The version string is
// passed in as a prop instead.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

/** How long the splash stays up before auto-dismissing (ms). */
export const SPLASH_DURATION_MS = 2000;

// Downscaled from the source emblem (142×79) by block-averaging glyph
// density — see docs/plans/2026-07-03-cli-splash-screen.md.
const EMBLEM_LARGE = `                              =%@*-
                            =%@@@@@#:
                           *%%%%%%@@%-
                         :#%%%%%%%%%@@*
                       :*%%%%%%%%%%%%%@%*.
                      =%%%%%%%%%%%%%%%%@@%.
                     =%%%%%%%%%%%%%%%%%%%@%-
                    *%%%%%%%%%%%%%%%%%%%%%@@=
                  .#%%%%%%%%@@@@@@@@%%%%%%@@@+
                 :#%%%%%%@@@@@@@@@@@@@@@%%%%@@+
                -%%%%%@@@@@@@@@@@@@@@@@@@@@%%@@#.
               -%%%%%@@@@@@@@@@@@@@@@@@@@@@@%%@@%:
              =%%%%@@@@@@@@@@@@@@@@@@@@@@@@@@@%@@%.
             +%%%%@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%@@%:
            =%%%@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@-
           -%%%@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%:
          :%%%%@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%
          #%%%%%@@@@@@@@@@@@@@@%--#%@@@@@@@@@@@@@%%@@@=
          #@@%%%%@@@@@@@@@@@@@@%:  -*@@@@@@@@@@@%%@@@@=
           #@@%%%%@@@@@@@@@@@@@%: .. -#@@@@@@@%%%%@@@=
            +@@@%%%@@@@@@@@@@@@%: :#=  =%@@@@%%%@@@%-
             =@@@@%%%@@@@@@@@@@%: -%%*:  +%@@%%@@@#
              +%@@@@%%@@@@@@@@@%: -%@@%*=.:+#@@@@#:
          .+*@@@@@@@@@%%%@@@@@@%: -%@@@@@#-  +@@@@@@*=
        =*%%%%@@@@@@@@@@@%%@@@@%: -#@@@@@@@*: :*@@@@@@%+=
     -*%%%%%%%%%%@@@@@@@@@@@@@@@: -%@@@@@@@@#-  -#@@@@@@@@*
     #%%%%%%%%%%%%%@@@@@@@@@@@@@: -#@@@@@%+-::.   *@@@@@@@@=
    =%%%%%%%%%%%%%%%@@@@@@@@@@@@: :*+--=%#. :+++++*@@@@@@@@%
    #@%%%%%%%%%%%%%@@@@@@@@@@@@%: .. -  -##  *@@@@@@@@@@@@@@=
   :@@%%%%%%%%%%%%@@@@@@@@@@@@@%:  .**=  *%= :%@@@@@@@@@@@@@%
   #@@@%%%%%%%%%%%@@@@@@@@@@@@@@- =#@@%- :**: =%@@@@@@@@@@@@@+
  =@@@@@%%%@@%%%%@@@@@@@@@@@@@@@@@@@@@@%- :: .-#@@@@@@@@@@@@@%.
 :@@@@@@%%@@@%%@@@@@@@@@@@@@@@@@@@@@@@@@%==*%%@@@@@@@@@@@@@@@@#
 *@@@@@@@%@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@:
:@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@+
=##########*######**##**#*********##**#*#######################*`;

const EMBLEM_SMALL = `                    =%%*:
                  :#%%@@@+
                 =%%%%%%%@#.
               .*%%%%%%%%%@%-
              =%%%%%%%%%%%%%@*.
             +%%%%%%@@@@@%%%%@%:
            *%%%%@@@@@@@@@@@%%@%:
           *%%%@@@@@@@@@@@@@@@%@%-
         :#%%@@@@@@@@@@@@@@@@@@@@@+
        :%%%@@@@@@@@@@@@@@@@@@@@@@@+
        #%%@@@@@@@@@@@@@@@@@@@@@@@@@-
       +%%@@@@@@@@@@@@#@@@@@@@@@@@@@%:
       %%%%@@@@@@@@@@%::*@@@@@@@@@%@@=
       -%@%%@@@@@@@@@%:.::*@@@@@%%@@*.
        :%@@%%@@@@@@@%.:%#::*@@%@@@-
         :#@@@%@@@@@@%.:%@%+.-#@@@=
      :+#@@@@@@@%@@@@%.:%@@@%=.+@@@%*-
   .*#%%%%%%@@@@@@@@@@.:%@@@@@*:.+%@@@@#-
   +%%%%%%%%%%@@@@@@@@::##*%* :----%@@@@%.
  .@%%%%%%%%%@@@@@@@@@:.-..-#=:%@@@@@@@@@+
  *@@%%%%%%%%@@@@@@@@@: =#+ +#.-@@@@@@@@@@.
 -@@@%%%%%%%@@@@@@@@@@#%@@@- -.:*@@@@@@@@@*
 %@@@@%@@%@@@@@@@@@@@@@@@@@%**%@@@@@@@@@@@@:
=@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@*`;

const EMBLEM_TINY = `             -%%+
           .*%%%@#:
          =%%%%%%%@*
         +%%%%%%%%%%#.
        +%%%@@@@@@@%@#.
      .*%@@@@@@@@@@@@@%-
     .#%@@@@@@@@@@@@@@@@-
     *%@@@@@@@@@@@@@@@@@%.
    :@%%@@@@@@%:+%@@@@@%@=
     =@%%@@@@@%.=-+%@%%@*
     .=@@%@@@@%.*@*-+@@*.
   -*%@@@@@@@@%.*@@@+:#@@#=.
  *%%%%%%@@@@@@.*#%#=-:+@@@%
 :@%%%%%%@@@@@@.:=.*:*@@@@@@=
 *@%%@%%@@@@@@@*%@*:-:%@@@@@%.
:@@@%@@@@@@@@@@@@@@#%@@@@@@@@=
*%%%%%%%%%%%%%%%%%%%%%%%%%%%%#`;

const EMBLEM_MICRO = `         -#%=
        +%%%%#.
      :#%%%%%%%-
     :%%@@@@@@@@=
    -%@@@@@@@@@@@+
   :%@@@@@@%@@@@@@=
   -%%@@@@@.+%@@%@+
    -@@@@@@:%++%@=
  =*%@@@@@@:@@%=*@#+.
 =%%%%%@@@@:+++-*%@@*
.%%%%%@@@@@+%+=:%@@@@:
*@@@@@@@@@@@@@%@@@@@@*`;

/** Rows the FULL footer (margin + wordmark + version + hint) needs below the art. */
const FOOTER_ROWS_FULL = 5;
/** Rows the COMPACT footer (margin + wordmark only) needs — used on short terminals. */
const FOOTER_ROWS_COMPACT = 2;

export interface SplashArt {
  art: string;
  width: number;
  height: number;
  /** True when only the compact footer (wordmark, no version/hint) fits. */
  compact: boolean;
}

function measure(art: string): Omit<SplashArt, 'compact'> {
  const lines = art.split('\n');
  return {
    art,
    width: Math.max(...lines.map((l) => l.length)),
    height: lines.length,
  };
}

const VARIANTS: Omit<SplashArt, 'compact'>[] = [
  measure(EMBLEM_LARGE),
  measure(EMBLEM_SMALL),
  measure(EMBLEM_TINY),
  measure(EMBLEM_MICRO),
];

/**
 * Pure helper: pick the largest emblem variant that fits `columns`×`rows`.
 * Tries the full footer first (wordmark + version + hint); on short
 * terminals falls back to the compact footer (wordmark only) so the
 * splash still shows in low panes like VS Code's integrated terminal.
 * Returns null only when even the micro variant doesn't fit.
 */
export function pickSplashArt(columns: number, rows: number): SplashArt | null {
  // Largest art wins: a bigger emblem with the compact footer beats a
  // smaller emblem with the full footer.
  for (const v of VARIANTS) {
    if (v.width > columns - 2) continue;
    if (v.height + FOOTER_ROWS_FULL <= rows) return { ...v, compact: false };
    if (v.height + FOOTER_ROWS_COMPACT <= rows) return { ...v, compact: true };
  }
  return null;
}

/**
 * Pure helper: should the splash be shown at all?
 * Skipped for non-TTY stdout (pipes/CI), when ZELARI_NO_SPLASH=1, or when
 * the terminal is too small for even the small variant.
 */
export function shouldShowSplash(opts: {
  isTTY: boolean;
  env: Record<string, string | undefined>;
  columns: number;
  rows: number;
}): boolean {
  if (!opts.isTTY) return false;
  if (opts.env['ZELARI_NO_SPLASH'] === '1') return false;
  return pickSplashArt(opts.columns, opts.rows) !== null;
}

function Splash({ onDone, version }: { onDone: () => void; version?: string }): React.ReactElement | null {
  const { isRawModeSupported } = useStdin();
  const columns = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const picked = pickSplashArt(columns, rows);

  useEffect(() => {
    const t = setTimeout(onDone, SPLASH_DURATION_MS);
    return () => clearTimeout(t);
  }, [onDone]);

  // Any key skips the splash. Guarded: useInput throws without raw mode.
  useInput(
    () => {
      onDone();
    },
    { isActive: isRawModeSupported === true },
  );

  if (!picked) return null;

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width={columns}
      height={rows - 1}
    >
      <Text color="cyan">{picked.art}</Text>
      <Box marginTop={1}>
        <Text bold color="white">
          {'Z E L A R I   C O D E'}
        </Text>
      </Box>
      {!picked.compact && (
        <Text dimColor>{`${version ? `v${version} — ` : ''}N-THEM Studio`}</Text>
      )}
      {!picked.compact && (
        <Text dimColor italic>
          press any key to skip
        </Text>
      )}
    </Box>
  );
}

/**
 * SplashGate — renders the splash first, then swaps in `children` (the
 * real App). The App therefore mounts only after the splash dismisses,
 * so its <Static> banner and raw-mode input never fight the splash.
 */
export function SplashGate({
  children,
  version,
}: {
  // Optional so React.createElement(SplashGate, { version }, child) type-checks
  // (children arrive via the third createElement argument).
  children?: React.ReactNode;
  version?: string;
}): React.ReactElement {
  const [show, setShow] = useState(() =>
    shouldShowSplash({
      isTTY: process.stdout.isTTY === true,
      env: process.env,
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }),
  );

  if (show) {
    return <Splash onDone={() => setShow(false)} version={version} />;
  }
  return <>{children}</>;
}
