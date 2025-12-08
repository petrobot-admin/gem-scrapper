const fs = require('fs');

// --- CONFIGURATION ---
const EMAIL_DB_FILE = 'email_master_db.json';
const CONFIG_FILE = 'mailer_config.json';
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://n8n.petrobot.in/webhook/f44185c4-da60-4386-87c3-c8c1b6661a05"; 
const DAYS_GAP = 10;
const MAX_MAILS = 4;

// --- HELPERS ---
const getDomain = (email) => email && email.includes('@') ? email.split('@')[1].toLowerCase() : null;

function getDaysDifference(lastDateString) {
    if (!lastDateString) return 999; 
    const lastDate = new Date(lastDateString);
    const currentDate = new Date();
    return Math.ceil(Math.abs(currentDate - lastDate) / (1000 * 60 * 60 * 24)); 
}

// Function to send the array directly
async function sendBatchWebhook(emailArray) {
    try {
        console.log(`[...] Sending batch of ${emailArray.length} emails...`);
        
        // We calculate the JSON string here to log it and send it
        // format: ["email1", "email2"]
        const jsonPayload = JSON.stringify(emailArray);
        
        console.log(`Payload: ${jsonPayload}`); // Shows [ "a", "b" ]

        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: jsonPayload // Sending raw array as the body
        });
        
        if (response.ok) {
            console.log("[OK] Webhook accepted the data.");
            return true;
        } else {
            console.error(`[!] Webhook failed: ${response.status} ${response.statusText}`);
            return false;
        }
    } catch (error) { 
        console.error("[!] Network/Fetch Error:", error);
        return false; 
    }
}

// --- MAIN EXECUTION ---
(async () => {
    console.log(`\n--- STARTING AUTOMATED MAILER (JSON LIST) ---`);
    console.log(`Time: ${new Date().toLocaleString()}`);

    // 1. Load Config
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error("[!] Error: Configuration file not found. Run mailer_manager.js first.");
        process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    
    if (!config.selectedDomains || config.selectedDomains.length === 0) {
        console.log("[!] No domains selected in config. Nothing to do.");
        return;
    }
    console.log(`Targeting Domains: ${config.selectedDomains.join(', ')}`);

    // 2. Load DB
    if (!fs.existsSync(EMAIL_DB_FILE)) {
        console.error("[!] Error: Database file not found.");
        return;
    }
    let emailDb = JSON.parse(fs.readFileSync(EMAIL_DB_FILE, 'utf8'));
    
    // 3. Process & Collect
    const emailsToSend = []; // Array of strings
    const emailsToUpdate = []; // References to DB objects

    const allEmails = Object.keys(emailDb);

    for (const key of allEmails) {
        let entry = emailDb[key];
        const domain = getDomain(entry.email);

        if (!config.selectedDomains.includes(domain)) continue;

        let shouldSend = false;

        // Rules
        if (entry.noOfMailSend === 0) {
            shouldSend = true;
        } else if (entry.noOfMailSend < MAX_MAILS) {
            const days = getDaysDifference(entry.LastMailSended);
            if (days > DAYS_GAP) {
                shouldSend = true;
            }
        }

        // Collect
        if (shouldSend) {
            emailsToSend.push(entry.email); 
            emailsToUpdate.push(entry);
        }
    }

    if (emailsToSend.length === 0) {
        console.log("No emails meet the criteria for sending.");
        return;
    }

    // 4. Send & Update
    // passing the array: ["a@b.com", "c@d.com"]
    const success = await sendBatchWebhook(emailsToSend);

    if (success) {
        emailsToUpdate.forEach(entry => {
            entry.noOfMailSend++;
            entry.LastMailSended = new Date().toISOString();
        });

        fs.writeFileSync(EMAIL_DB_FILE, JSON.stringify(emailDb, null, 2));
        console.log(`\n--- COMPLETE: Sent ${emailsToSend.length} emails. Database updated. ---`);
    } else {
        console.log(`\n--- FAILED: Database NOT updated due to webhook error. ---`);
    }

})();