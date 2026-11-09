const controlCharacters = /[\u0000-\u001F\u007F]/g;
const maximumTokens = 16;

export function toFtsMatchQuery(input: string): string | null {
  const tokens = input
    .replace(controlCharacters, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .slice(0, maximumTokens);

  if (tokens.length === 0) {
    return null;
  }

  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" AND ");
}
