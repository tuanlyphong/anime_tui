const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function formatTime(seconds) {
  if (!validTime(seconds)) return '--:--';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${String(minutes).padStart(2, '0')}:${remainder}`;
}

function clean(value) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

// Conservatively count non-Latin characters as two cells, including emoji.
// This may leave spare space, but never wraps a wide label onto the next line.
const cells = character => character.codePointAt(0) > 0xff ? 2 : 1;
const textWidth = text => [...text].reduce((total, character) => total + cells(character), 0);
function fit(text, width) {
  let result = '';
  let used = 0;
  for (const character of text) {
    used += cells(character);
    if (used > width) break;
    result += character;
  }
  return result;
}

export function formatStatus({ label, phase = 'playing', position, duration, target, buffered }, width = 80) {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 80;
  const preparing = phase === 'preparing';
  const numerator = preparing ? buffered : position;
  const denominator = preparing ? target : duration;
  const ratio = validTime(numerator) && validTime(denominator) && denominator > 0
    ? Math.min(1, numerator / denominator) : null;
  const percent = ratio === null ? '...' : `${Math.round(ratio * 100)}%`;
  const heading = preparing ? `Preparing ${clean(label)}`.trim() : `${clean(label)} ${clean(phase)}`.trim();
  const times = preparing
    ? `Resume at ${formatTime(target)} · Buffered to ${formatTime(buffered)}`
    : `${formatTime(position)} / ${formatTime(duration > 0 ? duration : undefined)}`;
  const base = `${heading} ${percent} · ${times}`;
  const barWidth = Math.min(20, width - textWidth(base) - 3);
  if (ratio === null || barWidth < 3) return fit(base, width);
  const filled = Math.round(ratio * barWidth);
  const bar = `[${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}]`;
  return fit(`${heading} ${bar} ${percent} · ${times}`, width);
}

export function createStatus(output = process.stderr) {
  let closed = false;
  let timer;
  let latest;
  let lastDraw = -Infinity;
  let transition;
  let visible = false;
  const draw = () => {
    timer = undefined;
    if (closed) return;
    const width = Math.max(0, (output.columns || 80) - 1);
    output.write(`\r\x1b[2K${formatStatus(latest, width)}`);
    visible = true;
    lastDraw = performance.now();
  };
  return {
    update(state) {
      if (closed) return;
      latest = { ...state };
      if (!output.isTTY) {
        const key = JSON.stringify([state.label, state.phase]);
        if (key !== transition) {
          transition = key;
          output.write(`${formatStatus(state, 160)}\n`);
        }
        return;
      }
      if (timer) return;
      const remaining = 100 - (performance.now() - lastDraw);
      if (remaining <= 0) draw();
      else {
        timer = setTimeout(draw, remaining);
        timer.unref();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      latest = undefined;
      if (visible) output.write('\r\x1b[2K');
    },
  };
}
