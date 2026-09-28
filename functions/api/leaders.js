// Cloudflare Pages Function — GET /api/leaders?stat=<key>&limit=<n>&season=<year>
//
// Why this exists: First Down Chile's "Líderes de la NFL" page used to call ESPN's public
// (unofficial, undocumented) stats API directly from the browser. This function moves that job
// to nflverse instead — the open, non-scraped dataset that powers nflfastR and most NFL analytics
// sites — because it's the more stable, openly-licensed source. The catch: nflverse only ships its
// weekly CSV as a GitHub *release asset*, and GitHub does not send CORS headers on those download
// URLs, so a browser can never fetch them directly (this was verified live: the exact same request
// that works fine from a server fails with a CORS network error from any browser tab). A Cloudflare
// Pages Function runs server-side — no browser, no CORS — so it can download and parse that CSV
// and hand the result back to the browser as plain, same-origin JSON.
//
// Response shape:
// { stat, season, updated, leaders: [ { id, name, team, position, total,
//     games: [ { week, team, opponent, value }, ... ] }, ... ] }
//
// Each leader's `games` array is already the full week-by-week breakdown (nflverse's file is one
// row per player per game), so this single endpoint covers both the season leaderboard AND the
// per-game chips the site shows under each name — no second request needed.

const STAT_MAP = {
  passingYards: { columns: ['passing_yards'] },
  passingTouchdowns: { columns: ['passing_tds'] },
  rushingYards: { columns: ['rushing_yards'] },
  rushingTouchdowns: { columns: ['rushing_tds'] },
  receivingYards: { columns: ['receiving_yards'] },
  receptions: { columns: ['receptions'] },
  receivingTouchdowns: { columns: ['receiving_tds'] },
  sacks: { columns: ['def_sacks'] },
  totalTackles: { columns: ['def_tackles_solo', 'def_tackles_with_assist'] },
  interceptions: { columns: ['def_interceptions'] }
};

const NFLVERSE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/';

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const statKey = url.searchParams.get('stat') || 'passingYards';
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 10, 50));
  const season = (url.searchParams.get('season') || String(new Date().getUTCFullYear())).replace(/[^0-9]/g, '');

  const statConfig = STAT_MAP[statKey];
  if (!statConfig) {
    return jsonResponse({ error: 'unknown stat key: ' + statKey }, 400);
  }

  // Cache the parsed-and-aggregated JSON at Cloudflare's edge, keyed by the full request URL, so
  // repeat visits (and every visitor switching between the same 10 category tabs) don't re-download
  // and re-parse the whole season CSV on every request.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  let csvText;
  try {
    const csvUrl = NFLVERSE_BASE + 'stats_player_week_' + season + '.csv';
    const csvRes = await fetch(csvUrl, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (!csvRes.ok) throw new Error('nflverse responded ' + csvRes.status);
    csvText = await csvRes.text();
  } catch (err) {
    return jsonResponse({ error: 'source unavailable', detail: String(err && err.message || err) }, 502);
  }

  let payload;
  try {
    payload = buildLeaders(csvText, statConfig, limit, statKey, season);
  } catch (err) {
    return jsonResponse({ error: 'parse failed', detail: String(err && err.message || err) }, 500);
  }

  const response = jsonResponse(payload, 200, { 'cache-control': 'public, max-age=600' });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {})
  });
}

function buildLeaders(csvText, statConfig, limit, statKey, season) {
  const rows = parseCSV(csvText);
  if (!rows.length) throw new Error('empty CSV');
  const header = rows[0];
  const col = {};
  header.forEach((name, i) => { col[name] = i; });

  const need = ['player_id', 'player_display_name', 'position', 'team', 'opponent_team', 'week', 'season_type'];
  for (const c of need) {
    if (!(c in col)) throw new Error('missing expected column: ' + c);
  }
  for (const c of statConfig.columns) {
    if (!(c in col)) throw new Error('missing stat column: ' + c);
  }

  const players = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < header.length) continue;
    if (row[col.season_type] !== 'REG') continue;

    let value = 0;
    for (const c of statConfig.columns) value += Number(row[col[c]]) || 0;

    const pid = row[col.player_id];
    if (!players.has(pid)) {
      players.set(pid, {
        id: pid,
        name: row[col.player_display_name],
        team: row[col.team],
        position: row[col.position],
        total: 0,
        games: []
      });
    }
    const p = players.get(pid);
    p.total += value;
    // Keep team on the player record current (handles in-season trades — last game wins).
    p.team = row[col.team];
    p.games.push({ week: Number(row[col.week]), team: row[col.team], opponent: row[col.opponent_team], value: round1(value) });
  }

  const leaders = [...players.values()]
    .filter(p => p.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(p => ({ ...p, total: round1(p.total), games: p.games.sort((a, b) => a.week - b.week) }));

  return { stat: statKey, season, updated: new Date().toISOString(), leaders };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped ("") quotes, commas and newlines
// inside quotes, and \r\n or \n line endings. nflverse's file has a few quoted list-valued columns
// (e.g. fg_made_list) that can contain internal commas, so a plain split(',') is not safe here.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip; \n right after will close the row
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
