// scoring.js - Walk-On Fantasy Football Scoring Engine

const SCORING = {
  passing: {
    yardsPerPoint: 25,       // 1 pt per 25 yards
    td: 4,
    interception: -2,
    twoPointConversion: 2
  },
  rushing: {
    yardsPerPoint: 10,       // 1 pt per 10 yards
    td: 6,
    twoPointConversion: 2
  },
  receiving: {
    yardsPerPoint: 10,       // 1 pt per 10 yards
    td: 6,
    reception: 0.5,          // half PPR
    twoPointConversion: 2
  },
  kicking: {
    xpMade: 1,
    xpMissed: -1,
    fg: [
      { minYds: 0,  maxYds: 39, made: 3,   missed: -2   },
      { minYds: 40, maxYds: 49, made: 4,   missed: -1   },
      { minYds: 50, maxYds: 59, made: 5,   missed: -0.5 },
      { minYds: 60, maxYds: 999, made: 6,  missed: -0.5 }
    ]
  },
  dst: {
    pointsAllowed: [
      { min: 0,  max: 0,   pts: 10 },
      { min: 1,  max: 6,   pts: 7  },
      { min: 7,  max: 13,  pts: 4  },
      { min: 14, max: 20,  pts: 1  },
      { min: 21, max: 27,  pts: 0  },
      { min: 28, max: 34,  pts: -1 },
      { min: 35, max: 45,  pts: -3 },
      { min: 46, max: 999, pts: -4 }
    ],
    sack: 1,
    interception: 2,
    fumbleRecovered: 2,
    fumbleForced: 1,
    td: 6,
    safety: 4,
    blockedKick: 2
  }
};

// Calculate points for a skill position player
function calculatePlayerScore(stats, position) {
  let points = 0;

  if (position === 'QB') {
    points += (stats.passingYards || 0) / SCORING.passing.yardsPerPoint;
    points += (stats.passingTDs || 0) * SCORING.passing.td;
    points += (stats.interceptions || 0) * SCORING.passing.interception;
    points += (stats.rushingYards || 0) / SCORING.rushing.yardsPerPoint;
    points += (stats.rushingTDs || 0) * SCORING.rushing.td;
    points += (stats.passingTwoPointConversions || 0) * SCORING.passing.twoPointConversion;
    points += (stats.rushingTwoPointConversions || 0) * SCORING.rushing.twoPointConversion;
  }

  if (position === 'RB') {
    points += (stats.rushingYards || 0) / SCORING.rushing.yardsPerPoint;
    points += (stats.rushingTDs || 0) * SCORING.rushing.td;
    points += (stats.receivingYards || 0) / SCORING.receiving.yardsPerPoint;
    points += (stats.receivingTDs || 0) * SCORING.receiving.td;
    points += (stats.receptions || 0) * SCORING.receiving.reception;
    points += (stats.rushingTwoPointConversions || 0) * SCORING.rushing.twoPointConversion;
    points += (stats.receivingTwoPointConversions || 0) * SCORING.receiving.twoPointConversion;
  }

  if (position === 'WR' || position === 'TE') {
    points += (stats.receivingYards || 0) / SCORING.receiving.yardsPerPoint;
    points += (stats.receivingTDs || 0) * SCORING.receiving.td;
    points += (stats.receptions || 0) * SCORING.receiving.reception;
    points += (stats.rushingYards || 0) / SCORING.rushing.yardsPerPoint;
    points += (stats.rushingTDs || 0) * SCORING.rushing.td;
    points += (stats.receivingTwoPointConversions || 0) * SCORING.receiving.twoPointConversion;
  }

  if (position === 'K') {
    points += (stats.xpMade || 0) * SCORING.kicking.xpMade;
    points += (stats.xpMissed || 0) * SCORING.kicking.xpMissed;

    // Field goals
    const fgAttempts = stats.fgAttempts || [];
    fgAttempts.forEach(attempt => {
      const tier = SCORING.kicking.fg.find(t => attempt.yards >= t.minYds && attempt.yards <= t.maxYds);
      if (tier) {
        points += attempt.made ? tier.made : tier.missed;
      }
    });
  }

  return Math.round(points * 100) / 100;
}

// Calculate points for a D/ST unit
function calculateDSTScore(stats) {
  let points = 0;

  // Points allowed tier
  const pa = stats.pointsAllowed || 0;
  const tier = SCORING.dst.pointsAllowed.find(t => pa >= t.min && pa <= t.max);
  if (tier) points += tier.pts;

  points += (stats.sacks || 0) * SCORING.dst.sack;
  points += (stats.interceptions || 0) * SCORING.dst.interception;
  points += (stats.fumblesRecovered || 0) * SCORING.dst.fumbleRecovered;
  points += (stats.fumblesForced || 0) * SCORING.dst.fumbleForced;
  points += (stats.touchdowns || 0) * SCORING.dst.td;
  points += (stats.safeties || 0) * SCORING.dst.safety;
  points += (stats.blockedKicks || 0) * SCORING.dst.blockedKick;

  return Math.round(points * 100) / 100;
}

// Fetch live stats for a player from ESPN
async function fetchPlayerStats(espnPlayerId, week) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/athletes/${espnPlayerId}/gamelog`;
    const res = await fetch(url);
    const data = await res.json();
    return parsePlayerGamelog(data, week);
  } catch (err) {
    console.error(`Error fetching stats for player ${espnPlayerId}:`, err);
    return null;
  }
}

// Parse ESPN gamelog response into our stat format
function parsePlayerGamelog(data, week) {
  try {
    const events = data.events?.events || [];
    const weekEvent = events.find(e => e.week === week);
    if (!weekEvent) return null;

    const stats = {};
    const labels = data.labels || [];
    const values = weekEvent.stats || [];

    labels.forEach((label, i) => {
      const val = parseFloat(values[i]) || 0;
      switch (label) {
        case 'passingYards': stats.passingYards = val; break;
        case 'passingTouchdowns': stats.passingTDs = val; break;
        case 'interceptions': stats.interceptions = val; break;
        case 'rushingYards': stats.rushingYards = val; break;
        case 'rushingTouchdowns': stats.rushingTDs = val; break;
        case 'receivingYards': stats.receivingYards = val; break;
        case 'receivingTouchdowns': stats.receivingTDs = val; break;
        case 'receptions': stats.receptions = val; break;
      }
    });

    return stats;
  } catch (err) {
    console.error('Error parsing gamelog:', err);
    return null;
  }
}

// Fetch D/ST stats for a team from ESPN
async function fetchDSTStats(espnTeamId, week) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${espnTeamId}/record`;
    const res = await fetch(url);
    const data = await res.json();
    // DST stats come from the scoreboard/game endpoint - placeholder for now
    return null;
  } catch (err) {
    console.error(`Error fetching DST stats for team ${espnTeamId}:`, err);
    return null;
  }
}

// Score an entire team's roster for a given week
async function scoreTeamForWeek(roster, week) {
  let totalPoints = 0;
  const breakdown = [];

  for (const player of roster) {
    if (player.position === 'DST') {
      const stats = await fetchDSTStats(player.espnTeamId, week);
      if (stats) {
        const pts = calculateDSTScore(stats);
        totalPoints += pts;
        breakdown.push({ player: player.team + ' D/ST', points: pts });
      }
      continue;
    }

    const stats = await fetchPlayerStats(player.id, week);
    if (stats) {
      const pts = calculatePlayerScore(stats, player.position);
      totalPoints += pts;
      breakdown.push({ player: `${player.firstName} ${player.lastName}`, points: pts });
    }
  }

  return { totalPoints: Math.round(totalPoints * 100) / 100, breakdown };
}

export { calculatePlayerScore, calculateDSTScore, fetchPlayerStats, fetchDSTStats, scoreTeamForWeek, SCORING };