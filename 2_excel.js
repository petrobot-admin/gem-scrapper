const fs = require('fs');
const XLSX = require('xlsx');

// --- CONFIGURATION ---
const INPUT_FILE = 'email_master_db.json';
const OUTPUT_FILE = 'output_email_db.xlsx';

// --- HELPER: SANITIZE SHEET NAMES ---
function sanitizeSheetName(domain) {
    let name = domain.toString().toLowerCase();
    name = name.replace(/[\\/?*[\]]/g, '');
    return name.substring(0, 30); 
}

// --- HELPER: STRICT EMAIL VALIDATION ---
// This filters out bonus@8.33, pmsby@rs.436.00, 0.0005lux@f1.6 etc.
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    
    const cleanEmail = email.trim();

    // 1. Regex Rule: 
    // - Must end with .[Letters]
    // - Extension must be at least 2 characters
    // - No numbers allowed after the last dot
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    
    if (!emailRegex.test(cleanEmail)) return false;

    // 2. Double Check for Hidden Numbers in Extension 
    // (catches cases like "user@domain.3days")
    const parts = cleanEmail.split('.');
    const tld = parts[parts.length - 1];
    
    if (/[0-9]/.test(tld)) return false; 

    // 3. Filter out common image extensions if they got in
    const junkExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'pdf'];
    if (junkExtensions.includes(tld.toLowerCase())) return false;

    return true;
}

// --- MAIN FUNCTION ---
function exportToExcel() {
    console.log('--- Starting Export Process ---');

    // 1. Check if DB exists
    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`[Error] File not found: ${INPUT_FILE}`);
        return;
    }

    // 2. Load JSON Data
    let rawData = {};
    try {
        const fileContent = fs.readFileSync(INPUT_FILE, 'utf8');
        rawData = JSON.parse(fileContent);
    } catch (e) {
        console.error('[Error] Could not parse JSON:', e.message);
        return;
    }

    const totalEmails = Object.keys(rawData).length;
    console.log(`Loaded ${totalEmails} raw entries.`);

    // 3. Group Data by Domain (With Filtering)
    const domainGroups = {};
    let skippedCount = 0;
    let validCount = 0;

    Object.values(rawData).forEach(entry => {
        const email = entry.email || "";
        
        // *** NEW FILTERING LOGIC ***
        if (isValidEmail(email)) {
            const domain = email.split('@')[1].trim().toLowerCase();
            
            if (!domainGroups[domain]) {
                domainGroups[domain] = [];
            }

            domainGroups[domain].push({
                "Email Address": entry.email,
                "Date Added": entry.dateAdded,
                "Mails Sent": entry.noOfMailSend,
                "Last Sent Date": entry.LastMailSended || "Never"
            });
            validCount++;
        } else {
            // Log skipped items to console so you can verify
            console.log(`   [Skipped Invalid]: ${email}`);
            skippedCount++;
        }
    });

    console.log(`\nSummary: ${validCount} Valid Emails | ${skippedCount} Invalid/Junk Removed`);
    
    const uniqueDomains = Object.keys(domainGroups).length;
    console.log(`Grouping into ${uniqueDomains} unique domains...`);

    // 4. Create Workbook
    const workbook = XLSX.utils.book_new();
    let sheetNameCounts = {}; 

    // 5. Create Worksheet for each Domain
    for (const [domain, rows] of Object.entries(domainGroups)) {
        let sheetName = sanitizeSheetName(domain);

        if (sheetNameCounts[sheetName]) {
            sheetNameCounts[sheetName]++;
            sheetName = `${sheetName.substring(0, 28)}_${sheetNameCounts[sheetName]}`;
        } else {
            sheetNameCounts[sheetName] = 1;
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);

        const colWidth = [
            { wch: 35 }, 
            { wch: 25 }, 
            { wch: 10 }, 
            { wch: 25 }  
        ];
        worksheet['!cols'] = colWidth;

        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    }

    // 6. Write File
    try {
        XLSX.writeFile(workbook, OUTPUT_FILE);
        console.log(`\n[SUCCESS] Excel file created: ${OUTPUT_FILE}`);
    } catch (e) {
        console.error(`[Error] Could not save Excel file. Is it currently open?`);
        console.error(e.message);
    }
}

// Run the function
exportToExcel();