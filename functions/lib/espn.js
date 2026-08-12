// functions/lib/espn.js
const fetch = require('node-fetch');

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary';

// Pull today's full scoreboard. ESPN returns every FBS game for the date —
// we filter down to your G6 teams afterward using a name list you control.
async function fetchScoreboard() {
  const res = await fetch(`${SCOREBOARD_URL}?limit=200`);
  if (!res.ok) throw new Error(`ESPN scoreboard fetch failed: ${res.status}`);
  const data = await res.json();
  return data.events || [];
}

// Returns only events that are (a) currently in progress and
// (b) involve at least one team from your known G6 team list.
function filterLiveG6Games(events, knownTeamNames) {
  return events.filter(event => {
    const state = event.status?.type?.state; // 'pre' | 'in' | 'post'
    if (state !== 'in') return false;

    const competitors = event.competitions?.[0]?.competitors || [];
    return competitors.some(c => knownTeamNames.has(normalizeTeamName(c.team?.displayName || c.team?.name)));
  });
}

function normalizeTeamName(name) {
  return (name || '').trim().toLowerCase();
}

// Fetch the full boxscore for one live event — this includes every
// player's stats, scoring plays, and team stats in a single call.
async function fetchGameSummary(eventId) {
  const res = await fetch(`${SUMMARY_URL}?event=${eventId}`);
  if (!res.ok) throw new Error(`ESPN summary fetch failed for event ${eventId}: ${res.status}`);
  return res.json();
}

// ─── Kicking helpers ──────────────────────────────────────────────────────────

// ESPN kicking labels (from the 'kicking' stat category):
//   'FG', 'FGA', '1-19', 'ATT', '20-29', 'ATT', '30-39', 'ATT',
//   '40-49', 'ATT', '50+', 'ATT', 'XP', 'XPA', 'PTS'
// The label array looks like: ['FG', 'FGA', '1-19', 'ATT', '20-29', 'ATT', ...]
// where each range is immediately followed by its attempts label.
//
// We parse by label value + position pairing: when we see a range label like
// '1-19', the next 'ATT' is its attempts. We scan the full labels array once
// and build a named lookup.
function parseKickingLabels(labels, values) {
  const raw = {};
  for (let i = 0; i < labels.length; i++) {
    const label = (labels[i] || '').trim();
    const val   = parseFloat(values[i]) || 0;

    // Total FG made/attempted
    if (label === 'FG')  { raw.fgMade = val; continue; }
    if (label === 'FGA') { raw.fgAtt  = val; continue; }

    // XP made/attempted
    if (label === 'XP')  { raw.xpMade = val; continue; }
    if (label === 'XPA') { raw.xpAtt  = val; continue; }

    // Per-range buckets — each range label is followed immediately by its ATT
    if (label === '1-19')  { raw.fg0_19Made  = val; raw.fg0_19Att  = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '20-29') { raw.fg20_29Made = val; raw.fg20_29Att = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '30-39') { raw.fg30_39Made = val; raw.fg30_39Att = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '40-49') { raw.fg40_49Made = val; raw.fg40_49Att = parseFloat(values[i + 1]) || 0; i++; continue; }
    if (label === '50+')   { raw.fg50Made    = val; raw.fg50Att    = parseFloat(values[i + 1]) || 0; i++; continue; }
  }
  return raw;
}

// Convert ESPN's raw kicking lookup into the flat stat fields that
// calculatePlayerScore() expects for position 'K'.
//
// Made FGs: initially derived from buckets, then overridden with exact
// distances from parseScoringPlayKicks() for better accuracy.
//
// Missed FGs: ESPN's 50+ bucket spans our 50-59 and 60+ tiers.
// We assign all 50+ misses to the 50+ penalty (-0.5) since that's
// the lighter penalty and we can't distinguish 50-59 from 60+ on misses.
//
// Miss tiers:  0-39 → -2,  40-49 → -1,  50+ → -0.5
function buildKickingStats(raw) {
  const missed = (made, att) => Math.max(0, (att || 0) - (made || 0));

  return {
    xpMade:        raw.xpMade || 0,
    xpMissed:      missed(raw.xpMade, raw.xpAtt),

    // Made FG buckets (may be overridden by parseScoringPlayKicks)
    fgMade0_39:    (raw.fg0_19Made || 0) + (raw.fg20_29Made || 0) + (raw.fg30_39Made || 0),
    fgMade40_49:   raw.fg40_49Made || 0,
    fgMade50_59:   raw.fg50Made    || 0,  // ESPN 50+ treated as 50-59; overridden if scoring plays available
    fgMade60:      0,                      // Cannot determine from buckets alone

    // Missed FG buckets
    fgMissed0_39:  missed(raw.fg0_19Made,  raw.fg0_19Att)
                 + missed(raw.fg20_29Made, raw.fg20_29Att)
                 + missed(raw.fg30_39Made, raw.fg30_39Att),
    fgMissed40_49: missed(raw.fg40_49Made, raw.fg40_49Att),
    fgMissed50:    missed(raw.fg50Made,    raw.fg50Att),
  };
}

// Parse the scoringPlays array to get exact distances for MADE field goals,
// so we can replace the bucket-based fgMade0_39/40_49/50_59/60 values with
// precise ones. Missed FGs don't appear in scoringPlays so we keep buckets for those.
//
// ESPN scoringPlay.text examples:
//   "Jake Veale 42 Yd Field Goal"
//   "42 Yard Field Goal Good"
//   "D.J. Douglas 52-Yard Field Goal"
//
// We match by kicker last name against the play text, and by team ID.
function parseScoringPlayKicks(scoringPlays, kickerDisplayName, espnTeamId) {
  if (!scoringPlays?.length) return null;

  const made = { fgMade0_39: 0, fgMade40_49: 0, fgMade50_59: 0, fgMade60: 0, xpMade: 0 };

  // Pull last name, accounting for suffixes like Jr./Sr./II/III
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

    // Only score plays by this player's team
    if (espnTeamId && playTeamId && playTeamId !== String(espnTeamId)) continue;

    // Only attribute plays that mention this kicker's last name
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

// Extract team-level D/ST stats for a given ESPN team ID from a game summary.
// Pulls from two places:
//   1. boxscore.teams[n].statistics  — sacks, INTs, fumbles from team stat block
//   2. scoringPlays                  — defensive TDs, safeties, blocked kicks
//   3. header competitors            — opponent's score → pointsAllowed
//
// Returns the stat object that calculateDSTScore() expects.
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

  // 2. Team boxscore statistics
  for (const teamEntry of (summary.boxscore?.teams || [])) {
    if (String(teamEntry.team?.id) !== teamIdStr) continue;

    const statLookup = {};
    for (const stat of (teamEntry.statistics || [])) {
      statLookup[stat.name] = parseFloat(stat.displayValue) || 0;
    }

    // ESPN NCAAF team stat names (these are the confirmed field names from
    // the team statistics block — verify against first live game logs)
    dst.sacks            = statLookup['totalSacks']           || statLookup['sacks']                    || 0;
    dst.interceptions    = statLookup['interceptions']        || 0;
    dst.fumblesRecovered = statLookup['fumblesRecovered']     || statLookup['defensiveFumblesRecovered'] || 0;
    dst.fumblesForced    = statLookup['fumblesForced']        || statLookup['forcedFumbles']             || 0;
    break;
  }

  // 3. Scoring plays — defensive/ST TDs, safeties, blocked kicks
  for (const play of (summary.scoringPlays || [])) {
    const type       = play.scoringType?.name || '';
    const playTeamId = String(play.team?.id || '');

    if (playTeamId !== teamIdStr) continue;

    switch (type) {
      case 'defensive-touchdown':
      case 'fumble-return-td':
      case 'interception-return-td':
      case 'kick-return-td':
      case 'punt-return-td':
        dst.touchdowns++;
        break;
      case 'blocked-kick-td':
      case 'blocked-punt-td':
        dst.touchdowns++;
        dst.blockedKicks++;
        break;
      case 'blocked-kick':
      case 'blocked-punt':
        dst.blockedKicks++;
        break;
      case 'safety':
        dst.safeties++;
        break;
    }
  }

  return dst;
}

// ─── Main boxscore parser ─────────────────────────────────────────────────────

// ESPN's boxscore groups stats by category (passing/rushing/receiving/etc)
// with a labels array + per-player stats array. This walks that structure
// and returns { [espnPlayerId]: { name, team, teamId, stats: { passingYards, ... } } }.
//
// Now handles kicking stats (via parseKickingLabels + parseScoringPlayKicks)
// in addition to the existing passing/rushing/receiving/fumbles categories.
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

          // Refine made FG distances using exact yardage from scoring plays
          const refined = parseScoringPlayKicks(scoringPlays, players[id].name, teamId);
          if (refined) {
            kickStats.fgMade0_39  = refined.fgMade0_39;
            kickStats.fgMade40_49 = refined.fgMade40_49;
            kickStats.fgMade50_59 = refined.fgMade50_59;
            kickStats.fgMade60    = refined.fgMade60;
            // Note: we keep bucket-based xpMade as a fallback if scoring plays
            // don't capture all XPs (e.g. early in a live game); take the higher value
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

// Maps ESPN's raw label/value pairs into the field names calculatePlayerScore expects.
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
}

// Extract DST stats for every team in a game summary.
// Returns a Map of espnTeamId → dstStats object.
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