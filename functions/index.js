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
    const POS_MAP = { PK: 'K', FB: 'RB', SB: 'RB', FL: 'WR', SE: 'WR' };
    positionByPlayer[key] = POS_MAP[row.position] || row.position;
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

// ─── Fantasy Week Boundaries ──────────────────────────────────────────────────
// Each week runs Tuesday 12:00pm MT → Monday 11:59pm MT.
// MT = MDT (UTC-6) through Nov 1, MST (UTC-7) after.
//
// Week 0 is a testing week covering the Aug 29 games.
// To switch to production after testing, remove the week0 entry and
// update the weekBoundaries array comment — no other changes needed.
//
// TO SWITCH TO PRODUCTION after Week 0 testing:
//   - Remove the week0 block and its entry in the boundaries array
//   - The function will naturally fall into Week 1 starting Sept 2

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

    console.log('ESPN team names seen:', [...new Set(events.flatMap(e =>
      (e.competitions?.[0]?.competitors || []).map(c => c.team?.displayName || '')
    ))].sort().join(', '));

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

      const boxscorePlayers = parseBoxscorePlayers(summary);
      const scoredPlayers = {};

      Object.values(boxscorePlayers).forEach(p => {
        const position = lookupPosition(p.name, p.team, positionByPlayer);
        if (!position) return; // not a draftable skill player — DST already captures their return TDs
        const points = calculatePlayerScore(p.stats, position);
        scoredPlayers[p.id] = { name: p.name, stats: p.stats, points, position };
      });

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

        if (Object.keys(scoredPlayers).length === 0 && Object.keys(scoredDST).length === 0) {
          console.log(`No scored data for event ${eventId} — skipping write to preserve existing data`);
          continue;
        }

        await db.collection('liveScores').doc(String(eventId)).set({
          eventId,
          homeTeam: competitors.find(c => c.homeAway === 'home')?.team?.displayName,
          awayTeam: competitors.find(c => c.homeAway === 'away')?.team?.displayName,
          status:   event.status?.type?.description,
          updatedAt: new Date().toISOString(),
          players:  scoredPlayers,
          dst:      scoredDST,
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

    liveSnap.forEach(doc => {
      const data = doc.data();
      Object.entries(data.players || {}).forEach(([espnId, p]) => {
        playerPoints[espnId] = (playerPoints[espnId] || 0) + (p.points || 0);
      });
      Object.values(data.dst || {}).forEach(d => {
        const key = normalizeTeamName(d.teamName);
        dstPoints[key] = (dstPoints[key] || 0) + (d.points || 0);
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

      // Use Tuesday-to-Monday week boundaries instead of rolling 7-day windows
      const now = new Date();
      const weekNum = getFantasyWeekNumber(now);

      const weekIndex = weeks.findIndex(w => w.week === weekNum);
      if (weekIndex === -1) {
        console.log(`League ${leagueId}: no schedule entry for week ${weekNum} — skipping.`);
        continue;
      }

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
            const pts = playerPoints[player.id] || 0;
            if (pts === 0) console.log(`Zero points for ${player.firstName} ${player.lastName} (id: ${player.id})`);
            total += pts;
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

// ─── Process Waiver Claims ────────────────────────────────────────────────────
exports.processWaivers = onSchedule(
  {
    schedule: 'every monday 10:00',
    timeZone: 'America/Denver',
    retryCount: 1,
  },
  async () => {
    const leaguesSnap = await db.collection('leagues').get();
    if (leaguesSnap.empty) {
      console.log('No leagues found — skipping waiver processing.');
      return;
    }

    for (const leagueDoc of leaguesSnap.docs) {
      const leagueId = leagueDoc.id;
      try {
        await processLeagueWaivers(leagueId);
      } catch (err) {
        console.error(`Error processing waivers for league ${leagueId}:`, err);
      }
    }
  }
);

async function processLeagueWaivers(leagueId) {
  const [portalSnap, draftSnap] = await Promise.all([
    db.collection('portal').doc(leagueId).get(),
    db.collection('drafts').doc(leagueId).get(),
  ]);

  if (!portalSnap.exists || !draftSnap.exists) {
    console.log(`League ${leagueId}: missing portal or draft doc — skipping.`);
    return;
  }

  const portalData = portalSnap.data();
  const draftData = draftSnap.data();

  const pendingClaims = (portalData.waiverClaims || []).filter(c => c.status === 'pending');
  if (!pendingClaims.length) {
    console.log(`League ${leagueId}: no pending claims.`);
    return;
  }

  const waiverPriority = portalData.waiverPriority || [];
  const teams = draftData.teams || [];
  let picks = [...(draftData.picks || [])];
  let updatedTeams = [...teams];

  const awardedPlayerIds = new Set();
  const teamsWon = new Set();

  const priorityRank = teamIdx => {
    const rank = waiverPriority.indexOf(teamIdx);
    return rank === -1 ? 999 : rank;
  };

  pendingClaims.sort((a, b) => priorityRank(a.teamIndex) - priorityRank(b.teamIndex));

  const processedClaims = (portalData.waiverClaims || []).map(claim => {
    if (claim.status !== 'pending') return claim;

    const addId = playerKey(claim.addPlayer);
    const teamIdx = claim.teamIndex;

    if (awardedPlayerIds.has(addId)) {
      return { ...claim, status: 'lost', processedAt: new Date().toISOString() };
    }

    const team = updatedTeams[teamIdx];
    const dropId = playerKey(claim.dropPlayer);
    const stillOnRoster = isPlayerOnTeam(claim.dropPlayer, picks, teamIdx, team);
    if (!stillOnRoster) {
      return { ...claim, status: 'lost', lostReason: 'drop target no longer on roster', processedAt: new Date().toISOString() };
    }

    awardedPlayerIds.add(addId);
    teamsWon.add(teamIdx);

    let dropHandled = false;
    picks = picks.map(p => {
      if (!dropHandled && p.teamIndex === teamIdx && playerKey(p) === dropId) {
        dropHandled = true;
        return { ...claim.addPlayer, teamIndex: teamIdx, pickNumber: p.pickNumber };
      }
      return p;
    });

    updatedTeams = updatedTeams.map((t, i) => {
      if (i !== teamIdx || !t.lineup) return t;
      const replaceIn = arr => (arr || []).map(p => {
        if (!p) return p;
        if (playerKey(p) === dropId) return { ...claim.addPlayer, teamIndex: teamIdx };
        return p;
      });
      return { ...t, lineup: { starting: replaceIn(t.lineup.starting), bench: replaceIn(t.lineup.bench) } };
    });

    const waivers = portalData.waivers || [];
    portalData.waivers = [
      ...waivers.filter(w => playerKey(w) !== dropId),
      { ...claim.dropPlayer, droppedAt: new Date().toISOString(), droppedBy: teamIdx }
    ];

    return { ...claim, status: 'won', processedAt: new Date().toISOString() };
  });

  const winners = waiverPriority.filter(idx => teamsWon.has(idx));
  const nonWinners = waiverPriority.filter(idx => !teamsWon.has(idx));
  const newPriority = [...nonWinners, ...winners];

  await db.collection('drafts').doc(leagueId).update({ picks, teams: updatedTeams });
  await db.collection('portal').doc(leagueId).update({
    waiverClaims: processedClaims,
    waiverPriority: newPriority,
    waivers: portalData.waivers,
  });

  const won = processedClaims.filter(c => c.status === 'won');
  const lost = processedClaims.filter(c => c.status === 'lost');
  const activitySnap = await db.collection('activity').doc(leagueId).get();
  const log = activitySnap.exists ? (activitySnap.data().log || []) : [];
  won.forEach(c => {
    log.push({
      message: `${teams[c.teamIndex]?.name} won waiver claim: added ${c.addPlayer.firstName} ${c.addPlayer.lastName}, dropped ${c.dropPlayer.firstName} ${c.dropPlayer.lastName}.`,
      timestamp: new Date().toISOString(),
    });
  });
  if (won.length || lost.length) {
    await db.collection('activity').doc(leagueId).set({ log });
  }

  console.log(`League ${leagueId}: ${won.length} claims won, ${lost.length} claims lost.`);
}

function playerKey(p) {
  if (!p) return '';
  return `${p.firstName}-${p.lastName}-${p.team}`.toLowerCase();
}

function isPlayerOnTeam(player, picks, teamIdx, teamObj) {
  const key = playerKey(player);
  if (teamObj?.lineup) {
    const all = [...(teamObj.lineup.starting || []), ...(teamObj.lineup.bench || [])];
    return all.some(p => p && playerKey(p) === key);
  }
  return picks.some(p => p.teamIndex === teamIdx && playerKey(p) === key);
}

// ─── Fantasy Week Number ──────────────────────────────────────────────────────
// Tuesday 12:00pm MT → Monday 11:59pm MT boundaries.
// Week 0 is active now for testing (Aug 29 games).
// After testing, remove the week 0 entry — Week 1 takes over Sept 2 noon MT.
function getFantasyWeekNumber(now) {
  const weekBoundaries = [
    { week: 1,  start: new Date('2026-09-01T18:00:00Z') },
    { week: 2,  start: new Date('2026-09-08T18:00:00Z') },
    { week: 3,  start: new Date('2026-09-15T18:00:00Z') },
    { week: 4,  start: new Date('2026-09-22T18:00:00Z') },
    { week: 5,  start: new Date('2026-09-29T18:00:00Z') },
    { week: 6,  start: new Date('2026-10-06T18:00:00Z') },
    { week: 7,  start: new Date('2026-10-13T18:00:00Z') },
    { week: 8,  start: new Date('2026-10-20T18:00:00Z') },
    { week: 9,  start: new Date('2026-10-27T18:00:00Z') },
    { week: 10, start: new Date('2026-11-03T19:00:00Z') }, // post-DST end, UTC-7
    { week: 11, start: new Date('2026-11-10T19:00:00Z') },
  ];

  if (now < weekBoundaries[0].start) return weekBoundaries[0].week;
  if (now >= weekBoundaries[weekBoundaries.length - 1].start) return 11;

  for (let i = weekBoundaries.length - 1; i >= 0; i--) {
    if (now >= weekBoundaries[i].start) return weekBoundaries[i].week;
  }

  return 0;
}