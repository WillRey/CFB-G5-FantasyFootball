const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fetch = require('node-fetch');

const { fetchScoreboard, filterLiveG6Games, fetchGameSummary, parseBoxscorePlayers, normalizeTeamName } = require('./lib/espn');
const { calculatePlayerScore } = require('./lib/scoring');

initializeApp();
const db = getFirestore();

const PLAYER_CSV_URL = 'https://walk-on-fantasy-football.web.app/g6_players_2026.csv';

// Pulls your live player CSV and returns a Set of team names (lowercased)
// plus a lookup from "firstName lastName team" -> position, so we know
// how to score each player once we have their raw stats.
async function loadKnownTeamsAndPositions() {
  const res = await fetch(PLAYER_CSV_URL);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  const teamNames = new Set();
  const positionByPlayer = {};

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });

    if (row.team) teamNames.add(normalizeTeamName(row.team));
    const key = `${row.firstName}-${row.lastName}-${row.team}`.toLowerCase();
    positionByPlayer[key] = row.position === 'PK' ? 'K' : row.position;
  }

  return { teamNames, positionByPlayer };
}

exports.checkLiveScores = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Denver',
    retryCount: 0 // don't retry on failure — next scheduled run will just try again
  },
  async () => {
    const { teamNames, positionByPlayer } = await loadKnownTeamsAndPositions();

    const events = await fetchScoreboard();
    const liveGames = filterLiveG6Games(events, teamNames);

    if (liveGames.length === 0) {
      console.log('No live G6 games right now — skipping.');
      return;
    }

    console.log(`${liveGames.length} live G6 game(s) found — pulling boxscores.`);

    for (const event of liveGames) {
      const eventId = event.id;
      let summary;
      try {
        summary = await fetchGameSummary(eventId);
      } catch (err) {
        console.error(`Failed to fetch summary for event ${eventId}:`, err.message);
        continue; // one bad game shouldn't block the others
      }

    const boxscorePlayers = parseBoxscorePlayers(summary);
          const scoredPlayers = {};

          Object.values(boxscorePlayers).forEach(p => {
            const position = lookupPosition(p.name, p.team, positionByPlayer);
            if (!position) {
              console.warn(`No CSV match for "${p.name}" (${p.team}) — skipping score.`);
              return; // unmatched players (e.g. OL, DL who show up in some stat blocks) are skipped, not guessed
            }
            const points = calculatePlayerScore(p.stats, position);
            scoredPlayers[p.id] = { name: p.name, stats: p.stats, points, position };
          });

      await db.collection('liveScores').doc(String(eventId)).set({
        eventId,
        homeTeam: event.competitions[0].competitors.find(c => c.homeAway === 'home')?.team?.displayName,
        awayTeam: event.competitions[0].competitors.find(c => c.homeAway === 'away')?.team?.displayName,
        status: event.status?.type?.description,
        updatedAt: new Date().toISOString(),
        players: scoredPlayers
      }, { merge: true });

      console.log(`Wrote live scores for event ${eventId} (${Object.keys(scoredPlayers).length} players).`);
    }
  }
);

// ESPN's boxscore gives a single "Firstname Lastname" string; your CSV
// stores firstName/lastName separately, with suffixes (Jr., Sr., II, III,
// IV) kept attached to lastName (e.g. "Engleman Jr."). A plain last-word
// split would grab just "Jr." as the lastName, so we check for a suffix
// first and pull two words in that case.
const NAME_SUFFIXES = new Set(['jr.', 'jr', 'sr.', 'sr', 'ii', 'iii', 'iv']);

function lookupPosition(displayName, team, positionByPlayer) {
  if (!displayName || !team) return null;

  const parts = displayName.trim().split(' ');
  let lastName = parts.pop();

  if (NAME_SUFFIXES.has(lastName.toLowerCase()) && parts.length > 1) {
    const suffix = lastName;
    lastName = `${parts.pop()} ${suffix}`;
  }

  const firstName = parts.join(' ');
  const key = `${firstName}-${lastName}-${team}`.toLowerCase();
  return positionByPlayer[key] || null;
}