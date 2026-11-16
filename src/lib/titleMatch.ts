import { normalize } from "./seasonSearch";

const ignoredWords = new Set([
  "the",
  "a",
  "and",
  "и",
  "і",
  "season",
  "seasons",
  "part",
  "cour",
  "final",
  "tv",
  "тв",
  "сезон",
  "сезоны",
  "часть",
  "частина",
]);
const scopeStart = /\s*\/\s*(?:\d+\s*)?(?:сезон|серии|сери[яй]|season|спецвыпуск|выпуски|episodes?)\b/i;
const numberWord = /^(?:\d+(?:st|nd|rd|th|й|я)?|ii|iii|iv|v|vi|vii|viii|ix|x)$/;

function wordsOf(text: string): string[] {
  return normalize(text.normalize("NFD").replace(/\p{M}/gu, ""))
    .split(" ")
    .filter((word) => word && !ignoredWords.has(word) && !numberWord.test(word));
}

function sameWords(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((word, index) => word === right[index]);
}

export function releaseNames(title: string): string[] {
  const bracket = title.indexOf("[");
  let head = bracket >= 0 ? title.slice(0, bracket) : title;
  const scope = head.search(scopeStart);
  if (scope > 0) head = head.slice(0, scope);
  let plain = head;
  for (let step = 0; step < 3; step++) plain = plain.replace(/\([^()]*\)/g, " ");
  return plain
    .split(/\s+\/\s+|\s*\/\s*(?=\p{Lu})/u)
    .map((part) => part.trim())
    .filter((part) => /\p{L}/u.test(part));
}

export function namedAs(title: string, names: string[]): boolean | null {
  const parts = names.flatMap((name) => [name, ...name.split(":").filter((part) => wordsOf(part).length >= 2)]);
  const wanted = parts.map(wordsOf).filter((words) => words.length > 0);
  const found = releaseNames(title);
  if (wanted.length === 0 || found.length === 0) return null;
  return found.some((part) => {
    const variants = [part, part.split(":")[0], part.split(/\s+[-–]\s+/)[0]];
    return variants.some((variant) => {
      const words = wordsOf(variant);
      return wanted.some((name) => sameWords(words, name));
    });
  });
}
