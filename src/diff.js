/**
 * Unified-diff helpers for line-anchored review comments.
 *
 * GitHub only accepts an inline review comment on a line that is part of the
 * diff (an added or context line inside a hunk, on the RIGHT/new side). Any
 * invalid anchor makes the WHOLE review request fail with 422, so every
 * LLM-proposed location is checked against this map before posting.
 */

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE = /^\+\+\+ (?:b\/)?(.+?)(?:\t|$)/;

/**
 * Walk a unified diff, invoking `onLine` for every line with the new-file
 * line number it maps to (null for deleted lines and non-hunk lines).
 * Hunk extent comes from the header's line counts, so file headers can never
 * be mistaken for +/- content lines.
 * @param {string} diff
 * @param {(line:string, info:{file:string|null, newLine:number|null, inHunk:boolean})=>void} onLine
 */
function walkDiff(diff, onLine) {
  let file = null;
  let newLine = 0;
  let oldLeft = 0; // lines of the current hunk still expected on each side
  let newLeft = 0;

  for (const line of String(diff).split('\n')) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk) {
      if (line.startsWith('\\')) {
        onLine(line, { file, newLine: null, inHunk }); // "\ No newline at end of file"
      } else if (line.startsWith('-')) {
        oldLeft--;
        onLine(line, { file, newLine: null, inHunk });
      } else if (line.startsWith('+')) {
        newLeft--;
        onLine(line, { file, newLine: file ? newLine++ : null, inHunk });
      } else {
        // context line (GitHub may strip the leading space of blank lines)
        oldLeft--;
        newLeft--;
        onLine(line, { file, newLine: file ? newLine++ : null, inHunk });
      }
      continue;
    }

    const hm = line.match(HUNK_HEADER);
    if (hm) {
      oldLeft = hm[1] === undefined ? 1 : parseInt(hm[1], 10);
      newLine = parseInt(hm[2], 10);
      newLeft = hm[3] === undefined ? 1 : parseInt(hm[3], 10);
    } else if (line.startsWith('diff --git ')) {
      file = null;
    } else if (line.startsWith('+++ ')) {
      const fm = line.match(NEW_FILE);
      file = !fm || fm[1] === '/dev/null' ? null : fm[1];
    }
    onLine(line, { file, newLine: null, inHunk: false });
  }
}

/**
 * Map each changed file to the set of new-side line numbers GitHub will
 * accept for an inline comment.
 * @param {string} diff
 * @returns {Map<string, Set<number>>}
 */
export function commentableLines(diff) {
  const map = new Map();
  walkDiff(diff, (_line, { file, newLine }) => {
    if (!file || newLine === null) return;
    if (!map.has(file)) map.set(file, new Set());
    map.get(file).add(newLine);
  });
  return map;
}

/**
 * Prefix every hunk line with its new-file line number so the LLM can cite
 * exact lines (models are unreliable at counting hunk offsets themselves).
 *
 *   `   12 +  const x: any = null;`   added line 12
 *   `      -  console.log(id);`       deleted (no new-side number)
 * @param {string} diff
 * @returns {string}
 */
export function annotateDiff(diff) {
  const out = [];
  walkDiff(diff, (line, { newLine, inHunk }) => {
    if (!inHunk) return out.push(line);
    const gutter = newLine === null ? '' : String(newLine);
    out.push(`${gutter.padStart(5)} ${line}`);
  });
  return out.join('\n');
}
