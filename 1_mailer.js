const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const EMAIL_DB_FILE = 'email_master_db.json';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // <--- REPLACE THIS
const DAYS_GAP = 10;
const MAX_MAILS = 4;
const DELAY_MS = 500;

// Helper: Calculate days difference
function getDaysDifference(lastDateString) {
    if (!lastDateString) return 999; 
    const lastDate = new Date(lastDateString);
    const currentDate = new Date();
    const diffTime = Math.abs(currentDate - lastDate);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
}

// Helper: Send Mail via Webhook
async function sendMailWebhook(email) {
    try {
        const payload = {
            mail_address: email
        };

        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`   [SUCCESS] Mail sent to: ${email}`);
            return true;
        } else {
            console.error(`   [FAILED] Webhook error for ${email}: ${response.status} ${response.statusText}`);
            return false;
        }
    } catch (error) {
        console.error(`   [ERROR] Network error for ${email}:`, error.message);
        return false;
    }
}

// --- MAIN LOGIC ---
(async () => {
    console.log("--- Starting Mailer Service ---");

    // 1. Load Database
    if (!fs.existsSync(EMAIL_DB_FILE)) {
        console.error("Error: Database file not found.");
        return;
    }
    
    let emailDb = {};
    try {
        emailDb = JSON.parse(fs.readFileSync(EMAIL_DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Error parsing JSON:", e);
        return;
    }

    const allEmails = Object.keys(emailDb);
    console.log(`Loaded ${allEmails.length} emails. Checking rules...`);
    
    let emailsSentCount = 0;
    let dbModified = false;

    // 2. Iterate through emails
    for (const emailKey of allEmails) {
        let entry = emailDb[emailKey];
        let shouldSend = false;

        // --- RULE 1: First Time Sending (NoOfMail is 0) ---
        if (entry.noOfMailSend === 0) {
            shouldSend = true;
            console.log(`-> Candidate (First Contact): ${entry.email}`);
        } 
        
        // --- RULE 2: Follow Up (>10 Days gap AND Sent < 4 times) ---
        else if (entry.noOfMailSend < MAX_MAILS) {
            const daysSinceLast = getDaysDifference(entry.LastMailSended);
            
            if (daysSinceLast > DAYS_GAP) {
                shouldSend = true;
                console.log(`-> Candidate (Follow-up): ${entry.email} | Last sent: ${daysSinceLast} days ago`);
            }
        }

        // --- ACTION: SEND AND UPDATE ---
        if (shouldSend) {
            // Send the mail
            const wasSent = await sendMailWebhook(entry.email);

            if (wasSent) {
                // Update Logic
                entry.noOfMailSend = entry.noOfMailSend + 1;
                entry.LastMailSended = new Date().toISOString();
                
                dbModified = true;
                emailsSentCount++;
            }
            
            // *** WAIT 0.5 SECONDS BETWEEN CALLS ***
            // This runs regardless of success or failure
            await new Promise(r => setTimeout(r, DELAY_MS)); 
        }
    }

    // 3. Save Changes
    if (dbModified) {
        fs.writeFileSync(EMAIL_DB_FILE, JSON.stringify(emailDb, null, 2));
        console.log(`\n--- COMPLETE: Sent ${emailsSentCount} emails. Database updated. ---`);
    } else {
        console.log(`\n--- COMPLETE: No emails matched the sending criteria. ---`);
    }

})();