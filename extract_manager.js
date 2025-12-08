const fs = require('fs');
const inquirer = require('inquirer');

// --- FILES ---
const CONFIG_FILE = 'scraper_config.json';
const BID_DB_FILE = 'bid_history_log.json';
const EMAIL_DB_FILE = 'email_master_db.json';

// --- DEFAULTS ---
const DEFAULT_CONFIG = {
    ministryString: "MINISTRY OF PETROLEUM AND NATURAL GAS",
    searchKeywords: ["*"],
    expiryDays: 60,
    inspectionKeywords: [
        "robotic", "robot", "crawler", "rover", "automated", "drone", "uav", "remotely operated", "rov",
        "visual", "rvi", "remote visual", "manual inspection", "camera", "borescope",
        "ndt", "non-destructive", "ut", "ultrasonic", "thickness measurement", "mfl", "magnetic flux",
        "eddy current", "ect", "radiography", "x-ray", "rt", "thermography", "infrared",
        "corrosion", "leakage", "crack", "weld", "coating", "asset integrity"
    ]
};

// --- DATA HELPERS ---
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        saveConfig(DEFAULT_CONFIG);
        return DEFAULT_CONFIG;
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log("   [✔] Configuration Saved.");
}

function loadJson(file) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch(e) {}
    return {};
}

// --- DATE HELPERS ---
function getDates() {
    const now = new Date();
    
    // Start of Today (00:00:00)
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Start of Month (1st)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Start of Week (Monday)
    const dayOfWeek = now.getDay(); // 0 is Sunday
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust when day is Sunday
    const startOfWeek = new Date(now.setDate(diff));
    startOfWeek.setHours(0,0,0,0);

    return { now, startOfDay, startOfWeek, startOfMonth };
}

// --- ACTIONS ---

async function viewStats() {
    const bids = loadJson(BID_DB_FILE);
    const emails = loadJson(EMAIL_DB_FILE);
    const { startOfDay, startOfWeek, startOfMonth } = getDates();

    // --- 1. BID ANALYSIS ---
    let bStats = { 
        total: 0, 
        insp: 0, 
        today: 0, 
        week: 0, 
        month: 0,
        todayInsp: 0
    };

    Object.values(bids).forEach(bid => {
        const ts = bid.timestamp; // Epoch
        const isInsp = bid.inspectionAnalysis && bid.inspectionAnalysis.isRelated;
        
        bStats.total++;
        if (isInsp) bStats.insp++;

        if (ts >= startOfDay.getTime()) {
            bStats.today++;
            if (isInsp) bStats.todayInsp++;
        }
        if (ts >= startOfWeek.getTime()) bStats.week++;
        if (ts >= startOfMonth.getTime()) bStats.month++;
    });

    // --- 2. EMAIL ANALYSIS ---
    let eStats = {
        total: 0,
        addedToday: 0,
        addedWeek: 0,
        addedMonth: 0,
        sentToday: 0,
        sentWeek: 0,
        sentMonth: 0,
        repeats: 0, // Emails sent > 1 time
        active: 0   // Emails sent at least once
    };
    
    const domainCounts = {};

    Object.values(emails).forEach(e => {
        eStats.total++;
        const dateAdded = new Date(e.dateAdded || 0);
        const lastSent = e.LastMailSended ? new Date(e.LastMailSended) : null;
        const sentCount = e.noOfMailSend || 0;

        // Acquisition Stats
        if (dateAdded >= startOfDay) eStats.addedToday++;
        if (dateAdded >= startOfWeek) eStats.addedWeek++;
        if (dateAdded >= startOfMonth) eStats.addedMonth++;

        // Sending Stats
        if (sentCount > 0) eStats.active++;
        if (sentCount > 1) eStats.repeats++;

        if (lastSent) {
            if (lastSent >= startOfDay) eStats.sentToday++;
            if (lastSent >= startOfWeek) eStats.sentWeek++;
            if (lastSent >= startOfMonth) eStats.sentMonth++;
        }

        // Domain Stats
        const domain = e.email.split('@')[1];
        if(domain) domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    });

    const topDomains = Object.entries(domainCounts)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 5)
        .map(([d, c]) => `   • ${d.padEnd(25)} : ${c} emails`)
        .join('\n');

    // --- OUTPUT DASHBOARD ---
    console.clear();
    console.log("\n=======================================================");
    console.log("               📊  SYSTEM DASHBOARD");
    console.log("=======================================================");

    console.log(`\n📂  BID ACQUISITION (Scraper)`);
    console.log(`   ──────────────────────────────────────────────────`);
    console.log(`   📅  Added Today:      ${bStats.today}  (Inspection: ${bStats.todayInsp})`);
    console.log(`   📅  This Week:        ${bStats.week}`);
    console.log(`   📅  This Month:       ${bStats.month}`);
    console.log(`   📦  TOTAL BIDS:       ${bStats.total}`);
    console.log(`   🎯  Useful Rate:      ${((bStats.insp/bStats.total)*100).toFixed(1)}% (${bStats.insp} inspection related)`);

    console.log(`\n📧  EMAIL GROWTH (Database)`);
    console.log(`   ──────────────────────────────────────────────────`);
    console.log(`   📅  New Today:        ${eStats.addedToday}`);
    console.log(`   📅  New This Week:    ${eStats.addedWeek}`);
    console.log(`   📅  New This Month:   ${eStats.addedMonth}`);
    console.log(`   👥  TOTAL EMAILS:     ${eStats.total}`);

    console.log(`\n🚀  MAILING PERFORMANCE (Outreach)`);
    console.log(`   ──────────────────────────────────────────────────`);
    console.log(`   📨  Sent Today:       ${eStats.sentToday}`);
    console.log(`   📨  Sent This Week:   ${eStats.sentWeek}`);
    console.log(`   📨  Sent This Month:  ${eStats.sentMonth}`);
    console.log(`   🔄  Follow-ups Sent:  ${eStats.repeats} people received >1 mail`);
    console.log(`   ✅  Active Contacts:  ${eStats.active} unique people contacted`);

    console.log(`\n🏢  TOP DOMAINS (Where leads are coming from)`);
    console.log(`   ──────────────────────────────────────────────────`);
    console.log(topDomains);
    console.log("\n=======================================================\n");
}

async function editConfig() {
    const config = loadConfig();

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'ministry',
            message: 'Target Ministry Name (Exact Match):',
            default: config.ministryString
        },
        {
            type: 'number',
            name: 'expiry',
            message: 'Bid Expiry (Days to keep in history):',
            default: config.expiryDays
        },
        {
            type: 'input',
            name: 'addKeyword',
            message: 'Add a new Inspection Keyword (Leave empty to skip):'
        }
    ]);

    config.ministryString = answers.ministry;
    config.expiryDays = answers.expiry;
    
    if (answers.addKeyword && answers.addKeyword.trim() !== "") {
        config.inspectionKeywords.push(answers.addKeyword.trim().toLowerCase());
        console.log(`   [+] Added keyword: ${answers.addKeyword}`);
    }

    saveConfig(config);
}

// --- MAIN MENU ---
(async () => {
    while(true) {
        // console.log("\n=== GEM SCRAPER MANAGER ==="); // Removed to keep dashboard clean
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Choose action:',
                choices: [
                    { name: '📊 View Dashboard Stats', value: 'stats' },
                    { name: '⚙️  Edit Configuration', value: 'config' },
                    { name: '❌ Exit', value: 'exit' }
                ]
            }
        ]);

        if (action === 'exit') break;
        if (action === 'stats') {
            await viewStats();
            // Pause so user can read the dashboard
            await inquirer.prompt([{type: 'input', name:'enter', message:'Press Enter to continue...'}]);
        }
        if (action === 'config') await editConfig();
    }
})();