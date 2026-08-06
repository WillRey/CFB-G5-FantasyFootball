import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyABxk_gvkfdvAVMr_Hd-x5OrTv6Qh2i4rE",
  authDomain: "walk-on-fantasy-football.firebaseapp.com",
  projectId: "walk-on-fantasy-football",
  storageBucket: "walk-on-fantasy-football.firebasestorage.app",
  messagingSenderId: "667624140764",
  appId: "1:667624140764:web:9bcf904b19013006aa2919"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

export function getLeagueId() {
  return localStorage.getItem('leagueId');
}

export function setLeagueId(id) {
  localStorage.setItem('leagueId', id);
}

export function clearLeagueId() {
  localStorage.removeItem('leagueId');
  localStorage.removeItem('leagueData');
}

export function generateLeagueId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'woff-';
  for (let i = 0; i < 5; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function initNav(currentPage) {
  onAuthStateChanged(auth, async user => {
    const nav = document.querySelector('nav');
    if (!nav) return;

    nav.innerHTML = '';

    const baseLinks = [
      { href: 'index.html', label: 'Home' },
      { href: 'players.html', label: 'Players' },
      { href: 'scores.html', label: 'Scores' },
      { href: 'setup.html', label: 'Create A League' },
    ];

    baseLinks.forEach(link => {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      if (currentPage === link.href) a.classList.add('active');
      nav.appendChild(a);
    });

    if (user) {
      const leagueId = getLeagueId();

      if (leagueId) {
        try {
          const draftDoc = await getDoc(doc(db, "drafts", leagueId));
          if (draftDoc.exists()) {
            const teams = draftDoc.data().teams || [];
            const hasTeam = teams.some(t =>
              t.email && t.email.toLowerCase() === user.email.toLowerCase()
            ) || teams.length > 0;

            if (hasTeam) {
              const myTeamLink = document.createElement('a');
              myTeamLink.href = 'myteam.html';
              myTeamLink.textContent = 'My Team';
              if (currentPage === 'myteam.html') myTeamLink.classList.add('active');
              nav.appendChild(myTeamLink);
            }
          }
        } catch (e) {
          console.error('Nav error:', e);
        }
      }

    // Add greeting
    const greeting = document.createElement('span');
    greeting.style.cssText = 'padding: 0 12px; font-size: 14px; color: #666; display: flex; align-items: center;';
    const firstName = user.displayName ? user.displayName.split(' ')[0] : '';
    greeting.textContent = firstName ? `Hello, ${firstName}!` : '';
    nav.appendChild(greeting);

    // Sign Out button
    const signOutBtn = document.createElement('a');
    signOutBtn.href = '#';
    signOutBtn.textContent = 'Sign Out';
    signOutBtn.onclick = async (e) => {
      e.preventDefault();
      await signOut(auth);
      clearLeagueId();
      window.location.href = 'index.html';
    };
    nav.appendChild(signOutBtn);

    } else {
      const loginLink = document.createElement('a');
      loginLink.href = 'login.html';
      loginLink.textContent = 'Login';
      if (currentPage === 'login.html') loginLink.classList.add('active');
      nav.appendChild(loginLink);
    }
  });
}