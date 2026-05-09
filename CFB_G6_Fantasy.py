import requests
import csv
import time

API_KEY = "wGonuprEJPw9b8O603cjKsKJUaptdltJQr6mq6YMq4k4za2L++y15CbrVPdtzKyJ"
HEADERS = {"Authorization": f"Bearer {API_KEY}"}

G5_CONFERENCES = ["AAC", "CUSA", "MAC", "MWC", "Sun Belt"]

def get_teams(conference):
    url = f"https://api.collegefootballdata.com/teams?conference={conference}"
    res = requests.get(url, headers=HEADERS)
    return res.json()

def get_roster(team, year=2025):
    url = f"https://api.collegefootballdata.com/roster?team={team}&year={year}"
    res = requests.get(url, headers=HEADERS)
    return res.json()

all_players = []

for conf in G5_CONFERENCES:
    print(f"Fetching teams for {conf}...")
    teams = get_teams(conf)
    
    for team in teams:
        team_name = team["school"]
        print(f"  Fetching roster for {team_name}...")
        
        roster = get_roster(team_name)
        
        for player in roster:
            player["conference"] = conf
            player["team"] = team_name
            all_players.append(player)
        
        time.sleep(0.3)  # be polite to the API

print(f"\nTotal players found: {len(all_players)}")

# Write to CSV
if all_players:
    keys = all_players[0].keys()
    with open("g5_players_2025.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(all_players)
    print("Saved to g5_players_2025.csv")