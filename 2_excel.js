const fs = require('fs');
const XLSX = require('xlsx');

// --- CONFIGURATION ---
const INPUT_FILE = 'email_master_db.json';
const CONFIG_FILE = 'mailer_config.json'; // <--- Reads your interest list
const OUTPUT_FILE = 'output_interested_emails.xlsx';

// --- HELPER: SANITIZE SHEET NAMES ---
function sanitizeSheetName(domain) {
    let name = domain.toString().toLowerCase();
    name = name.replace(/[\\/?*[\]]/g, '');
    return name.substring(0, 30); 
}

// --- HELPER: STRICT EMAIL VALIDATION ---
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const cleanEmail = email.trim();
    
    // Regex: Standard email validation
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) return false;

    // Logic: No numbers in TLD (e.g., .3days)
    const parts = cleanEmail.split('.');
    const tld = parts[parts.length - 1];
    if (/[0-9]/.test(tld)) return false; 

    // Logic: No image extensions
    const junkExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'pdf'];
    if (junkExtensions.includes(tld.toLowerCase())) return false;

    return true;
}

// --- MAIN FUNCTION ---
function exportToExcel() {
    console.log('--- Starting Export Process (Interested Domains Only) ---');

    // 1. Load Interested Domains Config
    let targetDomains = [];
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            targetDomains = config.selectedDomains || [];
            console.log(`[Config] Found ${targetDomains.length} interested domains.`);
        } catch (e) {
            console.error('[Error] Could not read config file.');
            return;
        }
    } else {
        console.error(`[Error] Config file (${CONFIG_FILE}) not found. Please run the manager script first.`);
        return;
    }

    if (targetDomains.length === 0) {
        console.log('[Warning] No interested domains selected in config. Nothing to export.');
        return;
    }

    // 2. Load Email DB
    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`[Error] Database file not found: ${INPUT_FILE}`);
        return;
    }

    let rawData = {};
    try {
        rawData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
    } catch (e) {
        console.error('[Error] Could not parse JSON DB:', e.message);
        return;
    }

    // 3. Filter and Group Data
    const domainGroups = {};
    let counts = { valid: 0, invalid: 0, ignored: 0 };

    Object.values(rawData).forEach(entry => {
        const email = entry.email || "";

        if (isValidEmail(email)) {
            const domain = email.split('@')[1].trim().toLowerCase();

            // *** CRITICAL CHANGE: FILTER BY INTEREST ***
            if (targetDomains.includes(domain)) {
                
                if (!domainGroups[domain]) {
                    domainGroups[domain] = [];
                }

                domainGroups[domain].push({
                    "Email Address": entry.email,
                    "Date Added": entry.dateAdded,
                    "Mails Sent": entry.noOfMailSend,
                    "Last Sent Date": entry.LastMailSended || "Never"
                });
                counts.valid++;

            } else {
                // Email is valid, but not in our interest list
                counts.ignored++;
            }
        } else {
            counts.invalid++;
        }
    });

    console.log(`\n--- SUMMARY ---`);
    console.log(`✅ Included (Interested): ${counts.valid}`);
    console.log(`🚫 Ignored (Not Interested): ${counts.ignored}`);
    console.log(`🗑️  Invalid/Junk Removed:   ${counts.invalid}`);
    
    // 4. Create Workbook
    const workbook = XLSX.utils.book_new();
    let sheetNameCounts = {}; 
    let sheetsCreated = 0;

    for (const [domain, rows] of Object.entries(domainGroups)) {
        let sheetName = sanitizeSheetName(domain);

        // Handle duplicate sheet names (Excel restriction)
        if (sheetNameCounts[sheetName]) {
            sheetNameCounts[sheetName]++;
            sheetName = `${sheetName.substring(0, 28)}_${sheetNameCounts[sheetName]}`;
        } else {
            sheetNameCounts[sheetName] = 1;
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);

        // Set column widths
        worksheet['!cols'] = [{ wch: 35 }, { wch: 25 }, { wch: 10 }, { wch: 25 }];

        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        sheetsCreated++;
    }

    // 5. Write File
    if (sheetsCreated > 0) {
        try {
            XLSX.writeFile(workbook, OUTPUT_FILE);
            console.log(`\n[SUCCESS] Excel file created: ${OUTPUT_FILE}`);
            console.log(`[Info] Contains ${sheetsCreated} sheets (one per domain).`);
        } catch (e) {
            console.error(`[Error] Could not save Excel file. Close it if it is open.`);
        }
    } else {
        console.log(`\n[Info] No matching emails found to export.`);
    }
}

// Run
exportToExcel();