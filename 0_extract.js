const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const pdfText = require('pdf-extraction'); // Library 1: Reliable Text Extraction

// --- CONFIGURATION ---
const DB_FILE = 'bid_history_log.json';
const EMAIL_DB_FILE = 'email_master_db.json'; 
const DOWNLOAD_DIR = path.resolve(__dirname, 'gemFile');
const EXPIRY_DAYS = 60; 
const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
console.log('Folder deleted successfully');

// *** EXISTING KEYWORDS LIST (For Search/Filtering Bids) ***
const SEARCH_KEYWORDS = ["security", "manpower", "cctv"]; 

// *** INSPECTION DETECTION CONFIGURATION ***
const INSPECTION_KEYWORDS = [
    // Robotics & Automation
    "robotic", "robot", "crawler", "rover", "automated",
    "drone", "uav", "unmanned", "remotely operated", "rov",
    
    // Visual & Manual
    "visual", "rvi", "remote visual", "manual inspection", 
    "camera", "video", "optical", "borescope", "videoscopy",
    
    // NDT / NDE Methods
    "ndt", "non-destructive", "non destructive",
    "ut", "ultrasonic", "thickness measurement", "gauging",
    "mfl", "magnetic flux", "magnetic particle", 
    "flux leakage", "eddy current", "ect",
    "radiography", "x-ray", "gamma", "rt", 
    "thermography", "infrared", "thermal",
    "acoustic emission", "penetrant", "xray", 
    
    // Specific Assets/Conditions
    "corrosion", "leakage", "crack", "weld", "coating",
    "asset integrity", "condition assessment"
];

// --- UTILITY: REGEX HELPER ---
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasWholeWord = (text, keyword) => {
    const pattern = `\\b${escapeRegExp(keyword)}\\b`;
    const regex = new RegExp(pattern, 'i'); // Case insensitive
    return regex.test(text);
};

// --- DATABASE FUNCTIONS (BID HISTORY) ---
function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

function saveDatabase(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error("Error saving database:", e);
    }
}

function pruneDatabase(db) {
    const now = Date.now();
    let changed = false;
    for (const [url, entry] of Object.entries(db)) {
        if (now - (entry.timestamp || 0) > EXPIRY_MS) {
            delete db[url];
            changed = true;
        }
    }
    if (changed) saveDatabase(db);
    return db;
}

// --- NEW: EMAIL DATABASE FUNCTIONS ---
function updateEmailDatabase(newEmailList) {
    let emailDb = {};
    
    // 1. Load existing Email DB
    if (fs.existsSync(EMAIL_DB_FILE)) {
        try {
            emailDb = JSON.parse(fs.readFileSync(EMAIL_DB_FILE, 'utf8'));
        } catch (e) {
            console.error("Error reading Email DB:", e);
            emailDb = {};
        }
    }

    let changed = false;
    let newCount = 0;
    let resetCount = 0;

    // 2. Process new emails
    newEmailList.forEach(email => {
        // CASE A: Email does NOT exist (Add new)
        if (!emailDb[email]) {
            emailDb[email] = {
                email: email,
                dateAdded: new Date().toISOString(), 
                noOfMailSend: 0,
                LastMailSended: null
            };
            changed = true;
            newCount++;
        } 
        // CASE B: Email EXISTS
        else {
            // Check specific condition: if sent count is 4, reset to 3
            if (emailDb[email].noOfMailSend === 4) {
                emailDb[email].noOfMailSend = 3;
                changed = true;
                resetCount++;
                console.log(`      -> [EMAIL DB] Reset counter for ${email} (4 -> 3)`);
            }
        }
    });

    // 3. Save if changes made
    if (changed) {
        try {
            fs.writeFileSync(EMAIL_DB_FILE, JSON.stringify(emailDb, null, 2));
            if (newCount > 0 || resetCount > 0) {
                console.log(`      -> [EMAIL DB] Stats: ${newCount} New Added | ${resetCount} Resets (4->3).`);
            }
        } catch (e) {
            console.error("Error saving Email DB:", e);
        }
    }
}

// --- HELPER: ANALYZE TEXT FOR INSPECTION ---
function analyzeTextForInspection(fullText) {
    if (!fullText) return { isInspection: false, summarySnippet: "" };

    let isRelated = false;
    let relevantSentences = [];

    const foundKeywords = INSPECTION_KEYWORDS.filter(kw => hasWholeWord(fullText, kw));
    
    if (foundKeywords.length > 0) {
        isRelated = true;
        const sentences = fullText.split(/(?<=[.!?]|\n)\s+/);
        
        for (const sentence of sentences) {
            const matchedTermsInSentence = foundKeywords.filter(kw => hasWholeWord(sentence, kw));

            if (matchedTermsInSentence.length > 0) {
                const cleanSentence = sentence.replace(/\s+/g, ' ').trim();
                
                if (cleanSentence.length > 15 && cleanSentence.length < 500) {
                    relevantSentences.push(cleanSentence);
                    console.log(`         [TRIGGER] Keyword(s): [${matchedTermsInSentence.join(', ')}]`);
                    console.log(`         [SOURCE]  Line: "${cleanSentence.substring(0, 100)}..."`);
                }
            }
            if (relevantSentences.length >= 3) break;
        }
    }

    return {
        isInspection: isRelated,
        summarySnippet: relevantSentences.join(' ... ')
    };
}

// --- FILE HELPER FUNCTIONS ---

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR);
}

async function waitForNewFile(previousFileList) {
    return new Promise((resolve) => {
        const checkInterval = 500;
        const maxWaitTime = 60000; 
        let elapsedTime = 0;

        const interval = setInterval(() => {
            elapsedTime += checkInterval;
            const currentFiles = fs.readdirSync(DOWNLOAD_DIR);
            
            const newFiles = currentFiles.filter(f => 
                !previousFileList.includes(f) && 
                !f.endsWith('.crdownload') && 
                !f.endsWith('.tmp')
            );

            if (newFiles.length > 0) {
                setTimeout(() => {
                    clearInterval(interval);
                    resolve(path.join(DOWNLOAD_DIR, newFiles[0]));
                }, 1000); 
            } else if (elapsedTime >= maxWaitTime) {
                clearInterval(interval);
                resolve(null);
            }
        }, checkInterval);
    });
}

async function downloadFile(url, outputPath) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Unexpected response ${response.statusText}`);
        await pipeline(response.body, fs.createWriteStream(outputPath));
        return true;
    } catch (error) {
        console.error(`   -> Failed to download ${url}:`, error.message);
        return false;
    }
}

// *** EXTRACT EMAILS (Cleaned & Lowercase) ***
async function extractEmailsFromBuffer(dataBuffer) {
    try {
        const originalWarn = console.warn;
        console.warn = () => {};
        
        let data;
        try {
            data = await pdfText(dataBuffer);
        } finally {
            console.warn = originalWarn; 
        }
        
        const text = data.text || "";
        
        // --- FIX IS HERE ---
        // 1. \b ensures word boundaries.
        // 2. The TLD part `\.[A-Za-z]{2,}` enforces ONLY letters at the end (no numbers like .00)
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;
        
        const rawMatches = text.match(emailRegex) || [];
        
        const cleanedEmails = rawMatches.map(email => {
            let s = email.toLowerCase();
            // Remove special chars from start
            s = s.replace(/^[^a-z0-9]+/, '');
            // Remove special chars from end
            s = s.replace(/[^a-z0-9]+$/, '');
            return s;
        }).filter(email => {
            // Extra safety checks
            if (!email.includes('@') || email.length < 5) return false;
            
            // Double check: Ensure the last part (TLD) really has no numbers
            // This filters out edge cases like "user@domain.55"
            const parts = email.split('.');
            const tld = parts[parts.length - 1];
            if (/[0-9]/.test(tld)) return false; 

            // Filter out common image extensions if they accidentally get parsed as emails
            const junkExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg'];
            if (junkExtensions.includes(tld)) return false;

            return true;
        });

        return {
            emails: [...new Set(cleanedEmails)], 
            rawText: text 
        };
    } catch (e) {
        return { emails: [], rawText: "" };
    }
}

// --- MAIN PROCESSING FUNCTION ---
async function processPdfFile(filePath) {
    let fullText = "";
    let extractedLinks = new Set();
    let foundKeywords = [];
    let status = "processed";

    const dataBuffer = fs.readFileSync(filePath);

    // --- PART A: Extract TEXT, EMAILS & KEYWORDS ---
    let mainExtraction = { emails: [], rawText: "" };
    try {
        mainExtraction = await extractEmailsFromBuffer(dataBuffer);
        fullText = mainExtraction.rawText;
        
        if (SEARCH_KEYWORDS.includes("*")) {
            foundKeywords = ["*"];
        } else {
            foundKeywords = SEARCH_KEYWORDS.filter(kw => hasWholeWord(fullText, kw));
        }
        
        if (foundKeywords.length > 0) status = "useful";

        const urlRegex = /https?:\/\/[^\s$.?#].[^\s]*/g;
        const textUrls = fullText.match(urlRegex) || [];
        textUrls.forEach(url => extractedLinks.add(url));

    } catch (e) {
        console.error("pdf-extraction error:", e.message);
    }

    // --- PART B: Extract HIDDEN LINKS ---
    try {
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const uint8Array = new Uint8Array(dataBuffer);
        
        const loadingTask = pdfjsLib.getDocument({ 
            data: uint8Array,
            disableFontFace: true, 
            useSystemFonts: true,
            verbosity: 0 
        });
        
        const doc = await loadingTask.promise;
        
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const annotations = await page.getAnnotations();
            
            for (const annot of annotations) {
                if (annot.subtype === 'Link' && annot.url) {
                    extractedLinks.add(annot.url);
                }
            }
        }
    } catch (e) {
        console.error("pdfjs-dist error:", e.message);
    }

    // --- PART C: Filter Links ---
    const pdfLinks = [...extractedLinks].filter(url => {
        try {
            const cleanUrl = url.split(/[?#]/)[0].toLowerCase();
            return cleanUrl.endsWith('.pdf');
        } catch (e) { return false; }
    });

    // --- PART D: INSPECTION ANALYSIS ---
    const inspectionAnalysis = analyzeTextForInspection(fullText);

    return {
        status: status,
        extracted: { 
            pdfLinks: pdfLinks, 
            emails: mainExtraction.emails 
        },
        keywords: foundKeywords,
        isInspection: inspectionAnalysis.isInspection,
        summarySnippet: inspectionAnalysis.summarySnippet
    };
}

// --- MAIN SCRIPT ---

(async () => {
    console.log('--- Initializing ---');
    let urlDb = loadDatabase();
    urlDb = pruneDatabase(urlDb);
    console.log(`Bid Database loaded: ${Object.keys(urlDb).length} entries.`);

    const browser = await puppeteer.launch({
        headless: "new", // Run in headless mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-maximized' 
        ]
    });
    const page = await browser.newPage();
    
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOAD_DIR,
    });

    await page.setViewport({ width: 1366, height: 768 });

    try {
        console.log('Navigating to GeM...');
        page.setDefaultNavigationTimeout(60000);
        await page.goto('https://bidplus.gem.gov.in/advance-search', { waitUntil: 'domcontentloaded' });

        console.log('Selecting Ministry...');
        await page.waitForSelector('#ministry-tab', { visible: true });
        await page.click('#ministry-tab');
        
        await page.waitForFunction(() => document.querySelector('#ministry').options.length > 1, { timeout: 60000 });
        
        await page.evaluate(() => {
            const select = document.querySelector('#ministry');
            const opt = Array.from(select.options).find(o => o.text.includes("MINISTRY OF PETROLEUM AND NATURAL GAS"));
            if (opt) select.value = opt.value;
            select.dispatchEvent(new Event('change')); 
        });

        await new Promise(r => setTimeout(r, 2000)); 
        await page.click('#tab1 #searchByBid');

        let hasNextPage = true;
        let pageNum = 1;

        while (hasNextPage) {
            console.log(`\n=== Processing Page ${pageNum} ===`);
            try {
                await page.waitForSelector('#bidCard .card', { visible: true, timeout: 60000 });
            } catch (e) {
                console.log("No bids found or timeout.");
                break;
            }

            const documentLinks = await page.$$('#bidCard a[href*="showbidDocument"]');
            
            for (const link of documentLinks) {
                const linkData = await page.evaluate(el => ({
                    href: el.href,
                    bidNo: el.innerText.trim()
                }), link);

                const { href, bidNo } = linkData;

                if (urlDb[href] && urlDb[href].status === "complete") {
                    console.log(`[SKIP] Already Complete: ${bidNo}`);
                    continue;
                }

                console.log(`[PROCESS] Downloading Main Bid: ${bidNo}...`);
                const filesBefore = fs.readdirSync(DOWNLOAD_DIR);

                try {
                    await link.click();
                    const newFile = await waitForNewFile(filesBefore);

                    if (newFile) {
                        const fileName = path.basename(newFile);
                        console.log(`   -> Saved: ${fileName}`);
                        
                        // 1. Process Main File
                        const result = await processPdfFile(newFile);
                        console.log(`   -> Keywords Found: ${result.keywords.join(", ")}`);
                        console.log(`   -> Linked PDFs: ${result.extracted.pdfLinks.length}`);

                        let allEmails = [...result.extracted.emails];
                        
                        // Initialize Summary Variables
                        let finalIsInspection = result.isInspection;
                        let finalSummary = result.summarySnippet;

                        if(finalIsInspection) {
                            console.log("   -> [MATCH] Inspection terms found in Main Document.");
                        }

                        // 2. Download & Process Linked PDFs
                        if (result.extracted.pdfLinks.length > 0) {
                            console.log(`   -> Processing linked PDFs...`);
                            for (const pdfUrl of result.extracted.pdfLinks) {
                                const tempFileName = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`;
                                const tempFilePath = path.join(DOWNLOAD_DIR, tempFileName);
                                
                                const downloaded = await downloadFile(pdfUrl, tempFilePath);
                                if (downloaded) {
                                    const linkedFileBuffer = fs.readFileSync(tempFilePath);
                                    
                                    // Extract text from linked PDF
                                    const linkedExtraction = await extractEmailsFromBuffer(linkedFileBuffer);
                                    
                                    // 2a. Add emails (already cleaned and lowercased)
                                    if (linkedExtraction.emails.length > 0) {
                                        allEmails.push(...linkedExtraction.emails);
                                    }

                                    // 2b. Analyze linked PDF for Inspection terms
                                    const linkedAnalysis = analyzeTextForInspection(linkedExtraction.rawText);
                                    
                                    if (linkedAnalysis.isInspection) {
                                        finalIsInspection = true;
                                        if (finalSummary.length < 1500 && linkedAnalysis.summarySnippet) {
                                            if(finalSummary) finalSummary += " | ";
                                            finalSummary += `(Linked Doc): ${linkedAnalysis.summarySnippet}`;
                                        }
                                        console.log(`      -> [MATCH] Inspection terms found in Linked PDF.`);
                                    }

                                    fs.unlinkSync(tempFilePath);
                                }
                            }
                        }

                        // Final Deduplicate (Local scope)
                        allEmails = [...new Set(allEmails)];

                        // *** UPDATE EMAIL DATABASE (Includes Reset Logic) ***
                        if (allEmails.length > 0) {
                            updateEmailDatabase(allEmails);
                        }

                        // 3. Update Status and Save Bid History
                        urlDb[href] = {
                            timestamp: Date.now(),
                            bidNumber: bidNo,
                            originalFileName: fileName,
                            status: "complete",
                            extractedData: { 
                                pdfLinks: result.extracted.pdfLinks, 
                                allEmails: allEmails 
                            },
                            matchedKeywords: result.keywords,
                            inspectionAnalysis: {
                                isRelated: finalIsInspection,
                                summary: finalSummary
                            }
                        };
                        saveDatabase(urlDb);
                        console.log(`   -> Entry Saved. Inspection Related? ${finalIsInspection}`);

                        // 4. Cleanup Main File
                        try {
                            fs.unlinkSync(newFile);
                            console.log(`   -> Deleted main file: ${fileName}`);
                        } catch (err) {
                            console.error(`   -> Error deleting file: ${err.message}`);
                        }

                    } else {
                        console.log(`   -> [Error] Download timed out`);
                    }
                } catch (err) {
                    console.error(`   -> [Error] Failed: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 1500));
            }

            const nextBtn = await page.$('#light-pagination .next');
            if (nextBtn && await page.evaluate(el => !el.classList.contains('disabled'), nextBtn)) {
                console.log('Navigating to next page...');
                await nextBtn.click();
                await new Promise(r => setTimeout(r, 3000));
                pageNum++;
            } else {
                hasNextPage = false;
            }
        }
        console.log('\n--- All Done ---');
    } catch (err) {
        console.error("Main Error:", err);
    }
})();