// functions/lib/espn.js
const fetch = require('node-fetch');

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary';

async function fetchScoreboard() {
  const res = await fetch(`${SCOREBOARD_URL}?limit=200&groups=80`);
  if (!res.ok) throw new Error(`ESPN scoreboard fetch failed: ${res.status}`);
  const data = await res.json();
  return data.events || [];
}

function filterLiveG6Games(events, knownTeamNames) {
  return events.filter(event => {
    const state = event.status?.type?.state;
    if (state !== 'in') return false;

    const competitors = event.competitions?.[0]?.competitors || [];
    return competitors.some(c => knownTeamNames.has(normalizeTeamName(c.team?.displayName || c.team?.name)));
  });
}

function normalizeTeamName(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function fetchGameSummary(eventId) {
  const res = await fetch(`${SUMMARY_URL}?event=${eventId}`);
  if (!res.ok) throw new Error(`ESPN summary fetch failed for event ${eventId}: ${res.status}`);
  return res.json();
}

// ─── Kicking helpers ──────────────────────────────────────────────────────────

function parseKickingLabels(labels, values) {
  const raw = {};
  for (let i = 0; i < labels.length; i++) {
    const label = (labels[i] || '').trim();
    const val   = parseFloat(values[i]) || 0;

    if (label === 'FG')  { raw.fgMade = val; continue; }
    if (label === 'FGA') { raw.fgAtt  = val; continue; }
    if (label === 'XP')  { raw.xpMade = val; continue; }
    if (label === 'XPA') { raw.xpAtt  = val; continue; }

    if (label === '1-19')  { raw.fg0_19Made  = val; raw.fg0_19Att  = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '20-29') { raw.fg20_29Made = val; raw.fg20_29Att = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '30-39') { raw.fg30_39Made = val; raw.fg30_39Att = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '40-49') { raw.fg40_49Made = val; raw.fg40_49Att = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '50+')   { raw.fg50Made    = val; raw.fg50Att    = parseFloat(values[i + 1]) || 0; i++; continue; }
  }
  return raw;
}

function buildKickingStats(raw) {
  const missed = (made, att) => Math.max(0, (att || 0) - (made || 0));

  return {
    xpMade:        raw.xpMade || 0,
    xpMissed:      missed(raw.xpMade, raw.xpAtt),

    fgMade0_39:    (raw.fg0_19Made || 0) + (raw.fg20_29Made || 0) + (raw.fg30_39Made || 0),
    fgMade40_49:   raw.fg40_49Made || 0,
    fgMade50_59:   raw.fg50Made    || 0,
    fgMade60:      0,

    fgMissed0_39:  missed(raw.fg0_19Made,  raw.fg0_19Att)
                 + missed(raw.fg20_29Made, raw.fg20_29Att)
                 + missed(raw.fg30_39Made, raw.fg30_39Att),
    fgMissed40_49: missed(raw.fg40_49Made, raw.fg40_49Att),
    fgMissed50:    missed(raw.fg50Made,    raw.fg50Att),
  };
}

function parseScoringPlayKicks(scoringPlays, kickerDisplayName, espnTeamId) {
  if (!scoringPlays?.length) return null;

  const made = { fgMade0_39: 0, fgMade40_49: 0, fgMade50_59: 0, fgMade60: 0, xpMade: 0 };

  const NAME_SUFFIXES = new Set(['jr.', 'jr', 'sr.', 'sr', 'ii', 'iii', 'iv']);
  const parts = (kickerDisplayName || '').trim().split(' ');
  let lastName = parts.pop() || '';
  if (NAME_SUFFIXES.has(lastName.toLowerCase()) && parts.length > 0) {
    lastName = `${parts.pop()} ${lastName}`;
  }
  const lastNameLower = lastName.toLowerCase();

  const fgRe = /(\d+)\s*[-\s]?yd(?:s|ard(?:s)?)?\s*field\s*goal/i;
  const xpRe = /extra\s*point|PAT\b/i;

  for (const play of scoringPlays) {
    const type       = play.scoringType?.name || '';
    const playTeamId = String(play.team?.id || '');
    const text       = play.text || play.shortText || '';

    if (espnTeamId && playTeamId && playTeamId !== String(espnTeamId)) continue;
    if (lastNameLower && !text.toLowerCase().includes(lastNameLower)) continue;

    if (type === 'field-goal' || fgRe.test(text)) {
      const match = fgRe.exec(text);
      if (!match) continue;
      const yards = parseInt(match[1], 10);
      if      (yards < 40) made.fgMade0_39++;
      else if (yards < 50) made.fgMade40_49++;
      else if (yards < 60) made.fgMade50_59++;
      else                 made.fgMade60++;

    } else if (type === 'extra-point' || xpRe.test(text)) {
      made.xpMade++;
    }
  }

  return made;
}

// ─── D/ST helper ──────────────────────────────────────────────────────────────

function parseDSTStats(summary, espnTeamId) {
  const teamIdStr = String(espnTeamId);

  const dst = {
    pointsAllowed:    0,
    sacks:            0,
    interceptions:    0,
    fumblesRecovered: 0,
    fumblesForced:    0,
    touchdowns:       0,
    safeties:         0,
    blockedKicks:     0,
  };

  // 1. Points allowed = opponent's final score
  const competitors = summary.header?.competitions?.[0]?.competitors || [];
  for (const comp of competitors) {
    if (String(comp.team?.id) !== teamIdStr) {
      dst.pointsAllowed = parseInt(comp.score, 10) || 0;
      break;
    }
  }

  // 2. Defensive player stats — sum sacks across all defenders
  for (const teamBlock of (summary.boxscore?.players || [])) {
    if (String(teamBlock.team?.id) !== teamIdStr) continue;

    for (const statCategory of (teamBlock.statistics || [])) {
      const keys = statCategory.keys || [];
      if ((statCategory.name || '').toLowerCase() !== 'defensive') continue;

      const sackIdx = keys.indexOf('sacks');
      if (sackIdx === -1) continue;

      for (const athleteEntry of (statCategory.athletes || [])) {
        dst.sacks += parseFloat(athleteEntry.stats?.[sackIdx]) || 0;
      }
    }
    break;
  }

  // Team stats block — interceptions only
  for (const teamEntry of (summary.boxscore?.teams || [])) {
    if (String(teamEntry.team?.id) !== teamIdStr) continue;
    const statLookup = {};
    for (const stat of (teamEntry.statistics || [])) {
      statLookup[stat.name] = parseFloat(stat.displayValue) || 0;
    }
    dst.interceptions = statLookup['interceptions'] || 0;
    break;
  }

// 3. Scoring plays — defensive/ST TDs, safeties, blocked kicks, fumble recoveries
for (const play of (summary.scoringPlays || [])) {
  const type       = play.scoringType?.name || '';
  const playTeamId = String(play.team?.id || '');
  const text       = play.text || '';

  if (playTeamId !== teamIdStr) continue;

  console.log(`Scoring play for team ${teamIdStr}: type="${type}" text="${text}"`);

  if (type === 'safety') {
    dst.safeties++;
    continue;
  }

  if (type === 'blocked-kick' || type === 'blocked-punt') {
    dst.blockedKicks++;
    continue;
  }

  if (type !== 'touchdown') continue;

  // ESPN uses generic "touchdown" for everything — classify by text
  const t = text.toLowerCase();

  const isFumbleReturn = /fumble[^.]*return[^.]*td|fumbled.*for a td/i.test(text);
  const isInterceptionReturn = /intercept[^.]*return[^.]*td|intercept[^.]*for a td/i.test(text);
  const isPuntReturn = /punt[^.]*return[^.]*td|returns.*for a td/i.test(text) && /punt/i.test(text);
  const isKickReturn = /kick[^.]*return[^.]*td|returns.*for a td/i.test(text) && /kick/i.test(text) && !/punt/i.test(text);
  const isBlockedKickTD = /blocked[^.]*kick[^.]*td|blocked[^.]*punt[^.]*td/i.test(text);

  // Offensive TDs: pass, run, rush — NOT defensive
  const isOffensive = /\bpass\b.*for a td|\brun\b.*for a td|\brush\b.*for a td/i.test(text);

  if (isOffensive) continue; // opponent's offensive TD — skip

  if (isFumbleReturn) {
    dst.touchdowns++;
    dst.fumblesRecovered++;
  } else if (isInterceptionReturn) {
    dst.touchdowns++;
    // interceptions already counted from boxscore team stats — don't double-count
  } else if (isPuntReturn || isKickReturn) {
    dst.touchdowns++;
  } else if (isBlockedKickTD) {
    dst.touchdowns++;
    dst.blockedKicks++;
  } else {
    // Catch-all: any non-offensive TD credited to this team is defensive
    dst.touchdowns++;
  }
}

  return dst;
}

// ─── Main boxscore parser ─────────────────────────────────────────────────────

function parseBoxscorePlayers(summaryData) {
  const players = {};
  const boxscorePlayers = summaryData.boxscore?.players || [];
  const scoringPlays    = summaryData.scoringPlays || [];

  boxscorePlayers.forEach(teamBlock => {
    const teamName = teamBlock.team?.displayName || '';
    const teamId   = String(teamBlock.team?.id || '');

    (teamBlock.statistics || []).forEach(statCategory => {
      const labels       = statCategory.labels || [];
      const categoryName = (statCategory.name || '').toLowerCase();

      (statCategory.athletes || []).forEach(athleteEntry => {
        const id = athleteEntry.athlete?.id;
        if (!id) return;

        if (!players[id]) {
          players[id] = {
            id,
            name:   athleteEntry.athlete?.displayName,
            team:   teamName,
            teamId,
            stats:  {}
          };
        }

        const values = athleteEntry.stats || [];

        if (categoryName === 'kicking') {
          const raw         = parseKickingLabels(labels, values);
          const kickStats   = buildKickingStats(raw);

          const refined = parseScoringPlayKicks(scoringPlays, players[id].name, teamId);
          if (refined) {
            kickStats.fgMade0_39  = refined.fgMade0_39;
            kickStats.fgMade40_49 = refined.fgMade40_49;
            kickStats.fgMade50_59 = refined.fgMade50_59;
            kickStats.fgMade60    = refined.fgMade60;
            kickStats.xpMade = Math.max(kickStats.xpMade, refined.xpMade);
          }

          Object.assign(players[id].stats, kickStats);

        } else {
          labels.forEach((label, i) => {
            mapStatToField(players[id].stats, categoryName, label, values[i]);
          });
        }
      });
    });
  });

  return players;
}

function mapStatToField(stats, category, label, rawValue) {
  if (rawValue === undefined || rawValue === null) return;

  if (category === 'passing') {
    if (label === 'C/ATT') return;
    if (label === 'YDS') stats.passingYards = parseFloat(rawValue) || 0;
    if (label === 'TD')  stats.passingTDs   = parseFloat(rawValue) || 0;
    if (label === 'INT') stats.interceptions = parseFloat(rawValue) || 0;
  }
  if (category === 'rushing') {
    if (label === 'YDS') stats.rushingYards = parseFloat(rawValue) || 0;
    if (label === 'TD')  stats.rushingTDs   = parseFloat(rawValue) || 0;
  }
  if (category === 'receiving') {
    if (label === 'YDS') stats.receivingYards = parseFloat(rawValue) || 0;
    if (label === 'TD')  stats.receivingTDs   = parseFloat(rawValue) || 0;
    if (label === 'REC') stats.receptions     = parseFloat(rawValue) || 0;
  }
  if (category === 'fumbles') {
    if (label === 'LOST') stats.fumblesLost = parseFloat(rawValue) || 0;
  }
  if (category === 'kickreturns') {
    if (label === 'TD') stats.kickReturnTDs = parseFloat(rawValue) || 0;
  }
  if (category === 'puntreturns') {
    if (label === 'TD') stats.puntReturnTDs = parseFloat(rawValue) || 0;
  }
}

function parseDSTStatsForGame(summaryData) {
  const dstMap = new Map();
  const competitors = summaryData.header?.competitions?.[0]?.competitors || [];
  for (const comp of competitors) {
    const teamId = String(comp.team?.id || '');
    if (teamId) {
      dstMap.set(teamId, parseDSTStats(summaryData, teamId));
    }
  }
  return dstMap;
}

module.exports = {
  fetchScoreboard,
  filterLiveG6Games,
  fetchGameSummary,
  parseBoxscorePlayers,
  parseDSTStatsForGame,
  normalizeTeamName,
};