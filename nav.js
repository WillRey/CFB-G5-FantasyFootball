import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCY7GbyNnvAcAMGVqp3RGaP1jGCm7sThg",
  authDomain: "walk-on-fantasy-football.firebaseapp.com",
  projectId: "walk-on-fantasy-football",
  storageBucket: "walk-on-fantasy-football.appspot.com",
  messagingSenderId: "667624140764",
  appId: "1:667624140764:web:f4c18e3b2c8a9f4d3e5b6c"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export function getLeagueId() {
  const params = new URLSearchParams(window.location.search);
  const urlLeague = params.get('league');
  if (urlLeague) {
    localStorage.setItem('leagueId', urlLeague);
    return urlLeague;
  }
  return localStorage.getItem('leagueId');
}

export function setLeagueId(id) {
  localStorage.setItem('leagueId', id);
}

async function getMyMatchupUrl() {
  try {
    const user = auth.currentUser;
    if (!user) return 'matchup.html';

    const leagueId = getLeagueId();
    if (!leagueId) return 'matchup.html';

    const [draftDoc, scheduleDoc] = await Promise.all([
      getDoc(doc(db, "drafts", leagueId)),
      getDoc(doc(db, "schedule", leagueId))
    ]);

    if (!draftDoc.exists() || !scheduleDoc.exists()) return 'matchup.html';

    const teams = draftDoc.data().teams || [];
    const myTeamIndex = teams.findIndex(t =>
      t.email && t.email.toLowerCase() === user.email.toLowerCase()
    );
    if (myTeamIndex === -1) return 'matchup.html';

    // Get current week using same boundaries as index.js
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
      { week: 10, start: new Date('2026-11-03T19:00:00Z') },
      { week: 11, start: new Date('2026-11-10T19:00:00Z') },
    ];

    const now = new Date();
    let currentWeek = 1;
    for (let i = weekBoundaries.length - 1; i >= 0; i--) {
      if (now >= weekBoundaries[i].start) {
        currentWeek = weekBoundaries[i].week;
        break;
      }
    }

    const weeks = scheduleDoc.data().weeks || [];
    const weekData = weeks.find(w => w.week === currentWeek);
    if (!weekData) return 'matchup.html';

    const matchupIndex = weekData.matchups.findIndex(m =>
      m.home === myTeamIndex || m.away === myTeamIndex
    );
    if (matchupIndex === -1) return 'matchup.html';

    return `matchup.html?week=${currentWeek}&matchup=${matchupIndex}`;
  } catch (e) {
    console.error('getMyMatchupUrl failed:', e);
    return 'matchup.html';
  }
}

export function initNav(activePage) {
  onAuthStateChanged(auth, async (user) => {
    const nav = document.querySelector('nav');
    if (!nav) return;

    if (!user) {
      nav.innerHTML = `
        <div class="nav-inner">
          <a href="index.html" class="nav-logo">
            <img src="/icons8-american-football-gradient-32.png" alt="WOFF" style="width:24px;height:24px;" />
            Walk-On FF
          </a>
          <div class="nav-links">
            <a href="login.html" class="${activePage === 'login.html' ? 'active' : ''}">Sign In</a>
          </div>
        </div>
      `;
      return;
    }

    const leagueId = getLeagueId();
    let teams = [];
    if (leagueId) {
      try {
        const draftDoc = await getDoc(doc(db, "drafts", leagueId));
        if (draftDoc.exists()) teams = draftDoc.data().teams || [];
      } catch (e) {}
    }

    const matchupUrl = await getMyMatchupUrl();

    const links = [
      { label: 'Home',     href: 'index.html' },
      { label: 'Scores',   href: 'scores.html' },
      { label: 'Matchup',  href: matchupUrl },
      { label: 'League',   href: 'league.html' },
      { label: 'My Team',  href: 'myteam.html' },
      { label: 'Sign Out', href: '#', id: 'signout-btn' },
    ];

    nav.innerHTML = `
      <div class="nav-inner">
        <a href="index.html" class="nav-logo">
          <img src="/icons8-american-football-gradient-32.png" alt="WOFF" style="width:24px;height:24px;" />
          Walk-On FF
        </a>
        <div class="nav-links">
          ${links.map(l => `
            <a href="${l.href}"
               ${l.id ? `id="${l.id}"` : ''}
               class="${activePage === l.href ? 'active' : ''}">
              ${l.label}
            </a>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById('signout-btn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await signOut(auth);
      localStorage.removeItem('leagueId');
      localStorage.removeItem('leagueData');
      window.location.href = 'login.html';
    });
  });
}