import requests
import csv
import time

API_KEY = "YOUR_API_KEY_HERE"

G6_CONFERENCES = {
    "AAC": 151,
    "CUSA": 12,
    "MAC": 15,
    "MWC": 17,
    "Pac-12": 9,
    "Sun Belt": 37
}

SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'PK', 'P']

def get_teams_espn(conference_id):
    url = f"https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/teams?groups={conference_id}&groupType=conference&enable=groups&limit=100"
    res = requests.get(url)
    data = res.json()
    teams = []
    league = data.get('sports', [{}])[0].get('leagues', [{}])[0]
    for group in league.get('groups', []):
        for team in group.get('teams', []):
            teams.append({'id': team['id'], 'name': team['displayName']})
    return teams

def get_roster_espn(team_id, team_name, conference):
    url = f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{team_id}/roster"
    res = requests.get(url)
    data = res.json()
    players = []
    for group in data.get('athletes', []):
        for athlete in group.get('items', []):
            position = athlete.get('position', {}).get('abbreviation', '')
            if position not in SKILL_POSITIONS:
                continue
            # Normalize PK to K
            if position == 'PK':
                position = 'K'
            players.append({
                'id': athlete.get('id', ''),
                'firstName': athlete.get('firstName', ''),
                'lastName': athlete.get('lastName', ''),
                'position': position,
                'team': team_name,
                'conference': conference,
                'jersey': athlete.get('jersey', ''),
                'year': athlete.get('experience', {}).get('years', ''),
            })
    return players

all_players = []

for conf_name, conf_id in G6_CONFERENCES.items():
    print(f"\nFetching teams for {conf_name}...")
    teams = get_teams_espn(conf_id)
    print(f"  Found {len(teams)} teams")

    for team in teams:
        print(f"  Fetching roster for {team['name']}...")
        roster = get_roster_espn(team['id'], team['name'], conf_name)
        all_players.extend(roster)
        time.sleep(0.3)

print(f"\nTotal skill position players found: {len(all_players)}")

if all_players:
    keys = all_players[0].keys()
    with open("g6_players_2026.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(all_players)
    print("Saved to g6_players_2026.csv")