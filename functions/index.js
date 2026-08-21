const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fetch = require('node-fetch');

const { fetchScoreboard, filterLiveG6Games, fetchGameSummary, parseBoxscorePlayers, parseDSTStatsForGame, normalizeTeamName } = require('./lib/espn');
const { calculatePlayerScore, calculateDSTScore } = require('./lib/scoring');

initializeApp();
const db = getFirestore();

const PLAYER_CSV_URL = 'https://walk-on-fantasy-football.web.app/g6_players_2026.csv';

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

exports.checkLiveScores = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Denver',
    retryCount: 0
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
        continue;
      }

      // ── Offensive players + kickers ─────────────────────────────────────────
      const boxscorePlayers = parseBoxscorePlayers(summary);
      const scoredPlayers = {};
      const returnTDBonus = {};

      Object.values(boxscorePlayers).forEach(p => {
        const position = lookupPosition(p.name, p.team, positionByPlayer);

        if (position) {
          const points = calculatePlayerScore(p.stats, position);
          scoredPlayers[p.id] = { name: p.name, stats: p.stats, points, position };
          return;
        }

        const returnTDPts =
          ((p.stats.kickReturnTDs || 0) + (p.stats.puntReturnTDs || 0)) * 6;

        if (returnTDPts > 0) {
          console.log(
            `Return TD bonus: ${p.name} (${p.team}) not in player pool — ` +
            `attributing ${returnTDPts}pts as returnTDBonus for team ${p.team}`
          );
          const teamKey = normalizeTeamName(p.team);
          returnTDBonus[teamKey] = (returnTDBonus[teamKey] || 0) + returnTDPts;
        }
      });

      // ── D/ST — one entry per G6 team in this game ───────────────────────────
      const dstMap = parseDSTStatsForGame(summary);
      const scoredDST = {};

      const competitors = event.competitions?.[0]?.competitors || [];
      for (const comp of competitors) {
        const teamId     = String(comp.team?.id || '');
        const teamName   = comp.team?.displayName || '';
        const teamAbbrev = comp.team?.abbreviation || teamId;

        if (!teamNames.has(normalizeTeamName(teamName))) continue;

        const dstStats = dstMap.get(teamId);
        if (!dstStats) continue;

        const points = calculateDSTScore(dstStats);
        scoredDST[teamId] = { teamId, teamName, teamAbbrev, stats: dstStats, points };
      }

      // ── Write to Firestore ──────────────────────────────────────────────────
      await db.collection('liveScores').doc(String(eventId)).set({
        eventId,
        homeTeam: competitors.find(c => c.homeAway === 'home')?.team?.displayName,
        awayTeam: competitors.find(c => c.homeAway === 'away')?.team?.displayName,
        status:   event.status?.type?.description,
        updatedAt: new Date().toISOString(),
        players:  scoredPlayers,
        dst:      scoredDST,
        returnTDBonus,
      }, { merge: true });

      console.log(
        `Wrote live scores for event ${eventId} — ` +
        `${Object.keys(scoredPlayers).length} players, ` +
        `${Object.keys(scoredDST).length} D/ST unit(s).`
      );
    }
  }
);

exports.updateFantasyScores = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Denver',
    retryCount: 0
  },
  async () => {
    const liveSnap = await db.collection('liveScores').get();
    if (liveSnap.empty) {
      console.log('No liveScores docs — skipping fantasy score update.');
      return;
    }

    const playerPoints = {};
    const dstPoints = {};
    const returnTDBonusByTeam = {};

    liveSnap.forEach(doc => {
      const data = doc.data();
      Object.entries(data.players || {}).forEach(([espnId, p]) => {
        playerPoints[espnId] = (playerPoints[espnId] || 0) + (p.points || 0);
      });
      Object.values(data.dst || {}).forEach(d => {
        const key = normalizeTeamName(d.teamName);
        dstPoints[key] = (dstPoints[key] || 0) + (d.points || 0);
      });
      Object.entries(data.returnTDBonus || {}).forEach(([teamKey, pts]) => {
        returnTDBonusByTeam[teamKey] = (returnTDBonusByTeam[teamKey] || 0) + pts;
      });
    });

    const leaguesSnap = await db.collection('leagues').get();
    if (leaguesSnap.empty) return;

    for (const leagueDoc of leaguesSnap.docs) {
      const leagueId = leagueDoc.id;

      const [draftSnap, scheduleSnap] = await Promise.all([
        db.collection('drafts').doc(leagueId).get(),
        db.collection('schedule').doc(leagueId).get(),
      ]);

      if (!draftSnap.exists || !scheduleSnap.exists) continue;

      const picks = draftSnap.data().picks || [];
      const teams = draftSnap.data().teams || [];
      const weeks = scheduleSnap.data().weeks || [];

      const seasonStart = new Date('2026-08-28');
      const now = new Date();
      const weekNum = Math.min(
        Math.max(Math.floor((now - seasonStart) / (7 * 24 * 60 * 60 * 1000)) + 1, 1),
        11
      );
      const weekIndex = weeks.findIndex(w => w.week === weekNum);
      if (weekIndex === -1) continue;

      const weekData = weeks[weekIndex];
      if (!weekData.matchups?.length) continue;

      const teamScores = {};

      teams.forEach((team, teamIndex) => {
        const teamPicks = picks.filter(p => p.teamIndex === teamIndex);
        let starters = [];

        if (team.lineup?.starting) {
          starters = team.lineup.starting.filter(Boolean);
        } else {
          const startingSlots = [
            { positions: ['QB'] },
            { positions: ['RB'] },
            { positions: ['RB'] },
            { positions: ['WR'] },
            { positions: ['WR'] },
            { positions: ['TE'] },
            { positions: ['RB','WR','TE'] },
            { positions: ['RB','WR','TE'] },
            { positions: ['K'] },
            { positions: ['DST'] },
          ];
          const roster = [...teamPicks];
          startingSlots.forEach(slot => {
            const idx = roster.findIndex(p => slot.positions.includes(p.position));
            if (idx !== -1) { starters.push(roster[idx]); roster.splice(idx, 1); }
          });
        }

        let total = 0;
        starters.forEach(player => {
          if (player.position === 'DST') {
            total += dstPoints[normalizeTeamName(player.team)] || 0;
          } else if (player.id) {
            total += playerPoints[player.id] || 0;
            const teamKey = normalizeTeamName(player.team);
            if (returnTDBonusByTeam[teamKey]) {
              total += returnTDBonusByTeam[teamKey];
              returnTDBonusByTeam[teamKey] = 0;
            }
          }
        });

        teamScores[teamIndex] = Math.round(total * 100) / 100;
      });

      const updatedMatchups = weekData.matchups.map(matchup => ({
        ...matchup,
        homeScore: teamScores[matchup.home] ?? matchup.homeScore ?? null,
        awayScore: teamScores[matchup.away] ?? matchup.awayScore ?? null,
      }));

      weeks[weekIndex] = { ...weekData, matchups: updatedMatchups };
      await db.collection('schedule').doc(leagueId).update({ weeks });

      console.log(`Updated fantasy scores for league ${leagueId} week ${weekNum}`);
    }
  }
);

exports.clearWeeklyScores = onSchedule(
  {
    schedule: 'every monday 09:00',
    timeZone: 'America/Denver',
    retryCount: 0
  },
  async () => {
    const liveSnap = await db.collection('liveScores').get();
    if (liveSnap.empty) {
      console.log('liveScores already empty — nothing to clear.');
      return;
    }

    const batch = db.batch();
    liveSnap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    console.log(`Cleared ${liveSnap.docs.length} liveScores doc(s) for new week.`);
  }
);