/**
 * What a filter box means, in three modes chosen by what was typed.
 *
 * No toggles: a mode you have to set is a mode you have to remember, and the
 * syntax says it.
 *
 * - `/pattern/` -- a regular expression. Case-insensitive unless the flags say
 *   otherwise. A pattern that will not compile filters nothing and says why.
 * - anything else -- a plain substring, case-insensitive, every occurrence of
 *   it, since a name is a path and the same word turns up in more than one
 *   segment.
 * - **fuzzy**, but only when the substring found nothing. The characters in
 *   order with anything between them, ranked. It is a fallback rather than a
 *   third syntax so that an exact answer is never buried under a loose one, and
 *   so that the list is never two kinds of match at once.
 */

export type Mode = "text" | "regex" | "fuzzy";

/** Where a query matched, as ranges into the text, for the highlighter. */
export type Ranges = [number, number][];

export type Query = { mode: "text"; text: string } | { mode: "regex"; re: RegExp } | { mode: "regex"; error: string };

/** `/…/` or `/…/flags` is a pattern; everything else is text. */
export function parseQuery(query: string): Query | undefined {
  const trimmed = query.trim();
  if (trimmed === "") {
    return undefined;
  }

  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(trimmed);
  if (delimited === null) {
    return { mode: "text", text: trimmed };
  }

  const [, pattern = "", flags = ""] = delimited;
  try {
    // `g` because every occurrence is wanted; `i` unless the flags disagree,
    // which is the same default the substring mode has.
    const wanted = new Set([...flags, "g"]);
    if (!flags.includes("i") && !flags.includes("I")) {
      wanted.add("i");
    }

    return { mode: "regex", re: new RegExp(pattern, [...wanted].join("")) };
  } catch (error) {
    return { mode: "regex", error: String((error as Error).message ?? error) };
  }
}

/** Every occurrence of a substring, case-insensitively. */
function textRanges(haystack: string, needle: string): Ranges {
  const ranges: Ranges = [];
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  let at = lower.indexOf(target);
  while (at >= 0) {
    ranges.push([at, at + target.length]);
    at = lower.indexOf(target, at + target.length);
  }

  return ranges;
}

function regexRanges(haystack: string, re: RegExp): Ranges {
  const ranges: Ranges = [];
  re.lastIndex = 0;

  for (const match of haystack.matchAll(re)) {
    // A pattern that can match nothing -- `a*` -- would otherwise be an
    // infinite row of empty highlights.
    if (match[0] === "") {
      continue;
    }

    ranges.push([match.index, match.index + match[0].length]);
  }

  return ranges;
}

/** Where `query` matched in `text`, or nothing when it did not. */
export function rangesOf(text: string, query: Query): Ranges | undefined {
  if (query.mode === "regex") {
    if (!("re" in query)) {
      return undefined;
    }

    const ranges = regexRanges(text, query.re);
    return ranges.length === 0 ? undefined : ranges;
  }

  const ranges = textRanges(text, query.text);
  return ranges.length === 0 ? undefined : ranges;
}

const boundary = /[/\-_.:@]/;

/**
 * The needle's characters in order, anywhere in the haystack, with a score.
 *
 * Greedy left to right rather than optimal. An optimal alignment needs a
 * matrix per candidate and this runs over every name on every keystroke; the
 * greedy one is what `fzf`'s simple path does and it is predictable, which
 * matters more here than being clever about `aab` in `abab`.
 *
 * The score rewards what makes a match feel intended: characters that ran
 * together, and characters that started a segment. `kam` scoring higher on
 * `kamino` than on `okra-machine` is the whole job.
 */
export function fuzzyRanges(haystack: string, needle: string): { ranges: Ranges; score: number } | undefined {
  const text = haystack.toLowerCase();
  const target = needle.toLowerCase().replace(/\s+/g, "");
  if (target === "") {
    return undefined;
  }

  const hit: number[] = [];
  let at = 0;
  for (const character of target) {
    const found = text.indexOf(character, at);
    if (found < 0) {
      return undefined;
    }

    hit.push(found);
    at = found + 1;
  }

  let score = 0;
  let previous = -2;
  for (const index of hit) {
    score += index === previous + 1 ? 8 : 1;
    if (index === 0 || boundary.test(text[index - 1] ?? "")) {
      score += 6;
    }

    previous = index;
  }

  // A short name matched by the same characters is the better answer: `kam` is
  // more likely to mean `kamino` than `stage/hday/kamino-edge`.
  score -= Math.min(10, Math.floor((text.length - target.length) / 8));

  // Adjacent hits become one range, so the highlight reads as a word rather
  // than as a row of single letters.
  const ranges: Ranges = [];
  for (const index of hit) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === index) {
      last[1] = index + 1;
    } else {
      ranges.push([index, index + 1]);
    }
  }

  return { ranges, score };
}

export type Match = { name: string; ranges: Ranges };

/**
 * Everything in `names` that `query` matches, and how it matched.
 *
 * Exact first: if anything matches as written, that is the answer and the order
 * is the order it came in. Only when nothing does are the fuzzy matches offered
 * instead, ranked, because at that point the alternative is an empty list.
 */
export function filterNames(names: string[], query: Query): { mode: Mode; matches: Match[] } {
  const matches: Match[] = [];
  for (const name of names) {
    const ranges = rangesOf(name, query);
    if (ranges !== undefined) {
      matches.push({ name, ranges });
    }
  }

  if (matches.length > 0 || query.mode !== "text") {
    return { mode: query.mode, matches };
  }

  const scored: { match: Match; score: number }[] = [];
  for (const name of names) {
    const fuzzy = fuzzyRanges(name, query.text);
    if (fuzzy !== undefined) {
      scored.push({ match: { name, ranges: fuzzy.ranges }, score: fuzzy.score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.match.name.localeCompare(b.match.name));
  return { mode: "fuzzy", matches: scored.map((entry) => entry.match) };
}
