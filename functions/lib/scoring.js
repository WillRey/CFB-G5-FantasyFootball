// functions/lib/scoring.js
// Server-side port of scoring.js — CommonJS, no browser fetch/DOM dependencies.
// Keep this in sync with the client-side scoring.js if scoring rules change.

const SCORING = {
  passing: {
    yardsPerPoint: 25,
    td: 4,
    interception: -2,
    twoPointConversion: 2
  },
  rushing: {
    yardsPerPoint: 10,
    td: 6,
    twoPointConversion: 2
  },
  receiving: {
    yardsPerPoint: 10,
    td: 6,
    reception: 0.5, // half PPR
    twoPointConversion: 2
  },
  fumbles: {
    lost: -2
  },
  kicking: {
    xpMade:   1,
    xpMissed: -1,
    // Made FG points by distance tier
    fgMade: {
      '0_39':  3,
      '40_49': 4,
      '50_59': 5,
      '60':    6,
    },
    // Missed FG penalties by distance tier
    fgMissed: {
      '0_39':  -2,
      '40_49': -1,
      '50':    -0.5,  // ESPN 50+ bucket — covers both 50-59 and 60+ misses
    }
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
    points += (stats.fumblesLost || 0) * SCORING.fumbles.lost;
  }

  if (position === 'RB') {
    points += (stats.rushingYards || 0) / SCORING.rushing.yardsPerPoint;
    points += (stats.rushingTDs || 0) * SCORING.rushing.td;
    points += (stats.receivingYards || 0) / SCORING.receiving.yardsPerPoint;
    points += (stats.receivingTDs || 0) * SCORING.receiving.td;
    points += (stats.receptions || 0) * SCORING.receiving.reception;
    points += (stats.rushingTwoPointConversions || 0) * SCORING.rushing.twoPointConversion;
    points += (stats.receivingTwoPointConversions || 0) * SCORING.receiving.twoPointConversion;
    points += (stats.fumblesLost || 0) * SCORING.fumbles.lost;
  }

  if (position === 'WR' || position === 'TE') {
    points += (stats.receivingYards || 0) / SCORING.receiving.yardsPerPoint;
    points += (stats.receivingTDs || 0) * SCORING.receiving.td;
    points += (stats.receptions || 0) * SCORING.receiving.reception;
    points += (stats.rushingYards || 0) / SCORING.rushing.yardsPerPoint;
    points += (stats.rushingTDs || 0) * SCORING.rushing.td;
    points += (stats.receivingTwoPointConversions || 0) * SCORING.receiving.twoPointConversion;
    points += (stats.fumblesLost || 0) * SCORING.fumbles.lost;
  }

  if (position === 'K') {
    // Extra points
    points += (stats.xpMade   || 0) * SCORING.kicking.xpMade;
    points += (stats.xpMissed || 0) * SCORING.kicking.xpMissed;

    // Made field goals — flat fields populated by espn.js kicking parser
    points += (stats.fgMade0_39  || 0) * SCORING.kicking.fgMade['0_39'];
    points += (stats.fgMade40_49 || 0) * SCORING.kicking.fgMade['40_49'];
    points += (stats.fgMade50_59 || 0) * SCORING.kicking.fgMade['50_59'];
    points += (stats.fgMade60    || 0) * SCORING.kicking.fgMade['60'];

    // Missed field goals
    points += (stats.fgMissed0_39  || 0) * SCORING.kicking.fgMissed['0_39'];
    points += (stats.fgMissed40_49 || 0) * SCORING.kicking.fgMissed['40_49'];
    points += (stats.fgMissed50    || 0) * SCORING.kicking.fgMissed['50'];
  }

  return Math.round(points * 100) / 100;
}

function calculateDSTScore(stats) {
  let points = 0;

  const pa   = stats.pointsAllowed || 0;
  const tier = SCORING.dst.pointsAllowed.find(t => pa >= t.min && pa <= t.max);
  if (tier) points += tier.pts;

  points += (stats.sacks            || 0) * SCORING.dst.sack;
  points += (stats.interceptions    || 0) * SCORING.dst.interception;
  points += (stats.fumblesRecovered || 0) * SCORING.dst.fumbleRecovered;
  points += (stats.fumblesForced    || 0) * SCORING.dst.fumbleForced;
  points += (stats.touchdowns       || 0) * SCORING.dst.td;
  points += (stats.safeties         || 0) * SCORING.dst.safety;
  points += (stats.blockedKicks     || 0) * SCORING.dst.blockedKick;

  return Math.round(points * 100) / 100;
}

module.exports = { calculatePlayerScore, calculateDSTScore, SCORING };