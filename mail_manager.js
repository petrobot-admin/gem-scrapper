const fs = require('fs');
const inquirer = require('inquirer'); 

// --- CONFIGURATION ---
const EMAIL_DB_FILE = 'email_master_db.json';
const CONFIG_FILE = 'mailer_config.json';

// --- HELPERS ---
function loadConfig() {
    const defaults = { selectedDomains: [], threshold: 10 };
    if (!fs.existsSync(CONFIG_FILE)) return defaults;
    try {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...defaults, ...data };
    } catch (e) { return defaults; }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`\n[✔] Configuration saved to ${CONFIG_FILE}`);
}

function loadDb() {
    if (!fs.existsSync(EMAIL_DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(EMAIL_DB_FILE, 'utf8')); } 
    catch (e) { return {}; }
}

const getDomain = (email) => email && email.includes('@') ? email.split('@')[1].toLowerCase() : null;

// --- ACTIONS ---

async function changeThreshold() {
    const config = loadConfig();
    const answer = await inquirer.prompt([{
        type: 'number',
        name: 'val',
        message: 'Set minimum email count threshold:',
        default: config.threshold
    }]);
    config.threshold = answer.val;
    saveConfig(config);
}

async function selectDomains() {
    const config = loadConfig();
    const emailDb = loadDb();
    const domainCounts = {};

    console.log("Analyzing database...");

    // Count domains
    Object.values(emailDb).forEach(entry => {
        const d = getDomain(entry.email);
        if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
    });

    // Filter
    const choices = Object.entries(domainCounts)
        .filter(([_, count]) => count >= config.threshold)
        .sort((a, b) => b[1] - a[1])
        .map(([domain, count]) => ({
            name: `${domain} (${count} emails)`,
            value: domain,
            checked: config.selectedDomains.includes(domain)
        }));

    if (choices.length === 0) {
        console.log(`\n[!] No domains found with >= ${config.threshold} emails.`);
        console.log(`    Try lowering the threshold in the main menu.\n`);
        return;
    }

    const answer = await inquirer.prompt([{
        type: 'checkbox',
        name: 'selected',
        message: 'Select domains to target:',
        choices: choices,
        pageSize: 15
    }]);

    config.selectedDomains = answer.selected;
    saveConfig(config);
    console.log(`\n[✔] Updated target list: ${config.selectedDomains.join(', ')}\n`);
}

// --- MAIN LOOP ---
(async () => {
    while (true) {
        const config = loadConfig();
        console.log(`\n--- MANAGER STATUS ---`);
        console.log(`Threshold: ${config.threshold}`);
        console.log(`Targets:   ${config.selectedDomains.length > 0 ? config.selectedDomains.join(', ') : 'None'}`);
        console.log(`----------------------`);

        const answer = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'Choose action:',
            choices: [
                { name: '📋 Select Domains', value: 'select' },
                { name: '⚙️  Set Threshold', value: 'threshold' },
                { name: '❌ Exit', value: 'exit' }
            ]
        }]);

        if (answer.action === 'exit') break;
        if (answer.action === 'threshold') await changeThreshold();
        if (answer.action === 'select') await selectDomains();
    }
})();