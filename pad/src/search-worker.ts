import { SEARCH_LIMIT, searchFile, type SearchFile, type SearchRequest, type SearchResults } from "./search-match";

const files = new Map<string, SearchFile>();
let newest = 0;
self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const request = event.data;
  newest = request.generation;
  for (const path of request.removed) files.delete(path);
  for (const file of request.updates) files.set(file.path, file);
  void run(request);
};

async function run(request: SearchRequest): Promise<void> {
  const result: SearchResults = { generation: request.generation, groups: [], truncated: false };
  let count = 0;
  let visited = 0;
  for (const file of [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (newest !== request.generation) return;
    const group = searchFile(file, request.options, SEARCH_LIMIT + 1 - count);
    if (group) {
      count += group.matches.length;
      if (count > SEARCH_LIMIT) {
        group.matches.length -= count - SEARCH_LIMIT;
        result.truncated = true;
      }
      if (group.matches.length) result.groups.push(group);
      if (result.truncated) break;
    }
    // Accept query changes and file updates between files.
    if (++visited % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (newest === request.generation) self.postMessage(result);
}
