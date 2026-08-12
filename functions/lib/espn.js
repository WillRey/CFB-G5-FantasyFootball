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
// player's stats for that game in a single call.
async function fetchGameSummary(eventId) {
  const res = await fetch(`${SUMMARY_URL}?event=${eventId}`);
  if (!res.ok) throw new Error(`ESPN summary fetch failed for event ${eventId}: ${res.status}`);
  return res.json();
}

// ESPN's boxscore groups stats by category (passing/rushing/receiving/etc)
// with a labels array + per-player stats array, similar in shape to CFBD's
// category/statType rows but nested differently. This walks that structure
// and returns { [espnPlayerId]: { passingYards, passingTDs, ... } }.
function parseBoxscorePlayers(summaryData) {
  const players = {};
  const boxscorePlayers = summaryData.boxscore?.players || [];

    boxscorePlayers.forEach(teamBlock => {
        const teamName = teamBlock.team?.displayName || '';

        (teamBlock.statistics || []).forEach(statCategory => {
        const labels = statCategory.labels || [];
        const categoryName = (statCategory.name || '').toLowerCase();

        (statCategory.athletes || []).forEach(athleteEntry => {
            const id = athleteEntry.athlete?.id;
            if (!id) return;

            if (!players[id]) {
            players[id] = {
                id,
                name: athleteEntry.athlete?.displayName,
                team: teamName,
                stats: {}
            };
            }

        const values = athleteEntry.stats || [];
        labels.forEach((label, i) => {
          mapStatToField(players[id].stats, categoryName, label, values[i]);
        });
      });
    });
  });

  return players;
}

// Maps ESPN's raw label/value pairs into the field names calculatePlayerScore expects.
// ESPN labels vary somewhat by sport config — these are the standard college football ones,
// but worth double-checking against a real live boxscore once games start.
function mapStatToField(stats, category, label, rawValue) {
  if (rawValue === undefined || rawValue === null) return;

  if (category === 'passing') {
    if (label === 'C/ATT') return; // combined field, skip — YDS/TD/INT below cover it
    if (label === 'YDS') stats.passingYards = parseFloat(rawValue) || 0;
    if (label === 'TD') stats.passingTDs = parseFloat(rawValue) || 0;
    if (label === 'INT') stats.interceptions = parseFloat(rawValue) || 0;
  }
  if (category === 'rushing') {
    if (label === 'YDS') stats.rushingYards = parseFloat(rawValue) || 0;
    if (label === 'TD') stats.rushingTDs = parseFloat(rawValue) || 0;
  }
  if (category === 'receiving') {
    if (label === 'YDS') stats.receivingYards = parseFloat(rawValue) || 0;
    if (label === 'TD') stats.receivingTDs = parseFloat(rawValue) || 0;
    if (label === 'REC') stats.receptions = parseFloat(rawValue) || 0;
  }
  if (category === 'fumbles') {
    if (label === 'LOST') stats.fumblesLost = parseFloat(rawValue) || 0;
  }
}

module.exports = { fetchScoreboard, filterLiveG6Games, fetchGameSummary, parseBoxscorePlayers, normalizeTeamName };