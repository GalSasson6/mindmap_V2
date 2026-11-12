// res.json(), but when the reply isn't valid JSON (an error page, or a reply cut off by a dropped
// connection) the error says which request it was and what came back, instead of Safari's bare
// "The string did not match the expected pattern."
export async function readJson(res: Response, what: string) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const detail = text.trim() ? `got "${text.trim().slice(0, 80)}"` : 'got an empty reply';
    throw new Error(`${what}: the server's reply was unreadable (HTTP ${res.status}, ${detail}). The connection may have dropped; try again.`);
  }
}
