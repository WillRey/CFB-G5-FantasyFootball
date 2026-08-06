console.log("--- NODE SCRIPT INITIATED ---");

const fs = require('fs');
const http = require('http'); // 🛠️ CHANGED FROM HTTPS TO HTTP

const G6_TEAMS = [
    // 🏆 PAC-12
    { id: 268, name: "Oregon State", conf: "Pac-12" }, 
    { id: 269, name: "Washington State", conf: "Pac-12" },
    { id: 2046, name: "Boise State", conf: "Pac-12" },       
    { id: 2132, name: "Colorado State", conf: "Pac-12" },   
    { id: 2239, name: "Fresno State", conf: "Pac-12" },     
    { id: 2529, name: "San Diego State", conf: "Pac-12" },   
    { id: 324, name: "Utah State", conf: "Pac-12" },         
    { id: 2641, name: "Texas State", conf: "Pac-12" },       

    // 🏔️ Mountain West (MWC)
    { id: 2005, name: "Air Force", conf: "MWC" }, 
    { id: 2440, name: "Nevada", conf: "MWC" }, 
    { id: 2294, name: "UNLV", conf: "MWC" }, 
    { id: 2439, name: "New Mexico", conf: "MWC" }, 
    { id: 2545, name: "San Jose State", conf: "MWC" }, 
    { id: 2751, name: "Wyoming", conf: "MWC" }, 
    { id: 62, name: "Hawaii", conf: "MWC" }, 
    { id: 2653, name: "UTEP", conf: "MWC" },                 
    { id: 2459, name: "Northern Illinois", conf: "MWC" },   
    { id: 2449, name: "North Dakota State", conf: "MWC" },   

    // ☀️ Sun Belt
    { id: 2026, name: "Appalachian State", conf: "Sun Belt" }, 
    { id: 2244, name: "Georgia Southern", conf: "Sun Belt" }, 
    { id: 2247, name: "Georgia State", conf: "Sun Belt" }, 
    { id: 2429, name: "Marshall", conf: "Sun Belt" }, 
    { id: 2569, name: "Coastal Carolina", conf: "Sun Belt" }, 
    { id: 2335, name: "James Madison", conf: "Sun Belt" }, 
    { id: 2460, name: "Old Dominion", conf: "Sun Belt" }, 
    { id: 322, name: "Troy", conf: "Sun Belt" }, 
    { id: 2514, name: "South Alabama", conf: "Sun Belt" }, 
    { id: 309, name: "Louisiana", conf: "Sun Belt" }, 
    { id: 2433, name: "UL Monroe", conf: "Sun Belt" }, 
    { id: 2633, name: "Southern Miss", conf: "Sun Belt" }, 
    { id: 2438, name: "Arkansas State", conf: "Sun Belt" }, 
    { id: 2348, name: "Louisiana Tech", conf: "Sun Belt" },  

    // 🌊 MAC
    { id: 2006, name: "Akron", conf: "MAC" }, 
    { id: 2032, name: "Ball State", conf: "MAC" }, 
    { id: 2084, name: "Bowling Green", conf: "MAC" }, 
    { id: 2110, name: "Buffalo", conf: "MAC" }, 
    { id: 2117, name: "Central Michigan", conf: "MAC" }, 
    { id: 2199, name: "Eastern Michigan", conf: "MAC" }, 
    { id: 2309, name: "Kent State", conf: "MAC" }, 
    { id: 2368, name: "Miami (OH)", conf: "MAC" }, 
    { id: 2515, name: "Ohio", conf: "MAC" }, 
    { id: 2649, name: "Toledo", conf: "MAC" }, 
    { id: 2711, name: "Western Michigan", conf: "MAC" }, 
    { id: 172, name: "Sacramento State", conf: "MAC" },      

    // 🇺🇸 Conference USA (CUSA)
    { id: 48, name: "Delaware", conf: "CUSA" },              
    { id: 2623, name: "Missouri State", conf: "CUSA" },       
    { id: 2168, name: "FIU", conf: "CUSA" }, 
    { id: 2334, name: "Liberty", conf: "CUSA" }, 
    { id: 2393, name: "Middle Tennessee", conf: "CUSA" }, 
    { id: 2428, name: "New Mexico State", conf: "CUSA" }, 
    { id: 2546, name: "Sam Houston", conf: "CUSA" }, 
    { id: 2717, name: "Western Kentucky", conf: "CUSA" }, 
    { id: 2287, name: "Jacksonville State", conf: "CUSA" }, 
    { id: 105, name: "Kennesaw State", conf: "CUSA" },

    // 🦅 American (AAC)
    { id: 2306, name: "Army", conf: "AAC" }, 
    { id: 2426, name: "Navy", conf: "AAC" }, 
    { id: 2655, name: "Tulsa", conf: "AAC" }, 
    { id: 2643, name: "Tulane", conf: "AAC" }, 
    { id: 251, name: "UTSA", conf: "AAC" }, 
    { id: 249, name: "North Texas", conf: "AAC" }, 
    { id: 351, name: "Charlotte", conf: "AAC" }, 
    { id: 224, name: "South Florida", conf: "AAC" }, 
    { id: 2116, name: "UAB", conf: "AAC" }, 
    { id: 151, name: "East Carolina", conf: "AAC" }, 
    { id: 252, name: "Rice", conf: "AAC" }, 
    { id: 235, name: "Memphis", conf: "AAC" }, 
    { id: 213, name: "FAU", conf: "AAC" }, 
    { id: 292, name: "Temple", conf: "AAC" }
];

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };

        // 🛠️ USING HTTP.GET INSTEAD OF HTTPS.GET
        http.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { reject(new Error(`Invalid JSON format from server`)); }
            });
        }).on('error', (err) => reject(err));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllRosters() {
    let allPlayers = [];

    for (const team of G6_TEAMS) {
        console.log(`Fetching active roster for ${team.name}...`);
        
        // 🛠️ CHANGED ENDPOINT FROM HTTPS:// TO HTTP://
        const url = `http://espn.com{team.id}/roster`;
        
        try {
            const data = await fetchJson(url);
            if (data.athletes) {
                data.athletes.forEach(group => {
                    group.items.forEach(player => {
                        allPlayers.push({
                            espnId: player.id,
                            name: player.fullName,
                            position: player.position ? player.position.abbreviation : "N/A",
                            jersey: player.jersey || "N/A",
                            team: team.name,
                            teamId: team.id,
                            conference: team.conf,
                            weight: player.weight,
                            height: player.displayHeight,
                            year: player.experience ? player.experience.name : "N/A"
                        });
                    });
                });
            }
        } catch (error) {
            console.error(`❌ Error fetching ${team.name}:`, error.message);
        }
        await sleep(150); 
    }

    console.log(`\n🎉 Success! Total G6 players found: ${allPlayers.length}`);
    fs.writeFileSync('g6_players_2026.json', JSON.stringify(allPlayers, null, 2));
    console.log("Saved dataset to g6_players_2026.json");
}

fetchAllRosters()
    .then(() => console.log("--- SCRIPT COMPLETE ---"))
    .catch(err => console.error("❌ CRITICAL SCRIPT ERROR:", err));
